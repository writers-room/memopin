/** 편집기 모듈 입구. 스타일(editor.css)은 editor.ts·toolbar.ts가 각각 가져온다. */
export { EMPTY_HTML, previewOf, sanitizeHtml, titleOf, toPlainText } from './sanitize.ts';
export { createEditor, detectTrigger, normalize } from './editor.ts';
export type { Editor, EditorOptions } from './editor.ts';
export { attachFormatToolbar } from './toolbar.ts';
