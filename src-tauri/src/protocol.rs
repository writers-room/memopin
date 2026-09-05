//! `memopin://image/<id>` — 이미지 메모의 그림을 웹뷰에 준다.
//!
//! 왜 커스텀 프로토콜인가: 그림은 데이터 폴더 안에 있고 그 폴더는 사용자가 언제든
//! 구글 드라이브 같은 곳으로 바꾼다. asset 프로토콜에 폴더를 미리 허용해 둘 수가
//! 없어서, 요청이 올 때마다 **지금의** 데이터 폴더에서 읽어 준다.
//!
//! 주소 모양이 플랫폼마다 다르다(Tauri 규칙).
//! - Windows/Linux: `http://memopin.localhost/image/<id>` → host "memopin.localhost", path "/image/<id>"
//! - macOS/iOS:     `memopin://image/<id>`                → host "image", path "/<id>"
//!
//! `<id>`는 반드시 uuid 모양인지 확인한다. 경로에 `..`가 섞여 데이터 폴더 바깥
//! 파일이 나가는 일을 막는 유일한 장치다.

use tauri::http::{Request, Response};
use tauri::{Manager, UriSchemeContext, Wry};

use crate::store::IMAGES_DIR;
use crate::AppState;

pub const SCHEME: &str = "memopin";

/// 만들어진 뒤로 바뀌지 않는 파일이라 마음껏 캐시하게 둔다(1년).
const CACHE_CONTROL: &str = "max-age=31536000";

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.as_bytes().iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// 요청 주소에서 그림의 id를 뽑는다. uuid가 아니면 None(= 404).
pub fn parse_image_request(host: Option<&str>, path: &str) -> Option<String> {
    let rest = match path.strip_prefix("/image/") {
        Some(rest) => rest,
        // macOS에서는 "image"가 host로 온다.
        None => {
            if host? != "image" {
                return None;
            }
            path.strip_prefix('/')?
        }
    };
    if !is_uuid(rest) {
        return None;
    }
    Some(rest.to_string())
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(404)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub fn handle(ctx: UriSchemeContext<'_, Wry>, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let Some(id) = parse_image_request(uri.host(), uri.path()) else {
        return not_found();
    };

    // 지금의 데이터 폴더만 알면 된다. 락은 짧게 잡는다(그림 읽기는 밖에서).
    let Some(state) = ctx.app_handle().try_state::<AppState>() else {
        return not_found();
    };
    let dir = {
        let Ok(store) = state.store.lock() else {
            return not_found();
        };
        store.dir().to_path_buf()
    };

    // store에 메모가 없어도 파일이 있으면 준다(휴지통에 있는 이미지 메모도 보여야 한다).
    let path = dir.join(IMAGES_DIR).join(format!("{id}.png"));
    let Ok(bytes) = std::fs::read(&path) else {
        return not_found();
    };
    Response::builder()
        .status(200)
        .header("Content-Type", "image/png")
        .header("Cache-Control", CACHE_CONTROL)
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f6b1c2a-9d4e-4f80-9a1b-0c2d3e4f5a6b";

    #[test]
    fn accepts_both_platform_shapes() {
        assert_eq!(
            parse_image_request(Some("memopin.localhost"), &format!("/image/{ID}")),
            Some(ID.to_string())
        );
        assert_eq!(
            parse_image_request(Some("image"), &format!("/{ID}")),
            Some(ID.to_string())
        );
    }

    #[test]
    fn rejects_anything_that_is_not_a_uuid() {
        // 경로 탈출.
        assert_eq!(
            parse_image_request(Some("memopin.localhost"), "/image/../../settings.json"),
            None
        );
        assert_eq!(
            parse_image_request(Some("image"), "/../../settings.json"),
            None
        );
        // 빈 id, 다른 길, 확장자를 붙인 것, 길이는 맞지만 uuid가 아닌 것.
        assert_eq!(parse_image_request(Some("memopin.localhost"), "/image/"), None);
        assert_eq!(
            parse_image_request(Some("memopin.localhost"), &format!("/other/{ID}")),
            None
        );
        assert_eq!(
            parse_image_request(Some("memopin.localhost"), &format!("/image/{ID}.png")),
            None
        );
        assert_eq!(
            parse_image_request(Some("memopin.localhost"), "/image/zzzzzzzz-9d4e-4f80-9a1b-0c2d3e4f5a6b"),
            None
        );
        // host가 없고 path도 /image/로 시작하지 않으면 볼 것이 없다.
        assert_eq!(parse_image_request(None, &format!("/{ID}")), None);
    }
}
