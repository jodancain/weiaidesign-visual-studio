# Incomplete CJK font regression fixture

`incomplete-cjk.woff2` is the unchanged former `public/fonts/source-han-sans.woff2` from repository commit `11e75515758165d0db2f7806d6d7d279c40ab3b4` (Git blob `4ceadca9560c63c124ffe60f24e03118828d4225`). It was extracted with `git show HEAD:public/fonts/source-han-sans.woff2` before the original interface's four public font files were upgraded to complete faces.

- Actual embedded family: Noto Sans CJK SC; PostScript name: NotoSansCJKsc-Regular.
- Embedded copyright: © 2014–2021 Adobe (http://www.adobe.com/).
- License: SIL Open Font License 1.1; see the included project license at [fonts/LICENSE](../../fonts/LICENSE).
- File size: 905,680 bytes; glyph count: 6,648.
- SHA-256: `00e0d028f1ec6861615c08c3821c5f0907fe4fa8953509cf00877ae9db36aad3`.

This real subset contains `中` and omits `文`. It preserves the regression coverage for missing-glyph rejection, source-pixel preservation, foreign-owner denial and safe import rollback, and the two-file/same-family export test. It is only a test fixture; the public four-font tests continue to read the new complete files from `public/fonts/`.

The fixture bytes and embedded font identity were not modified. Renaming the file does not rename the typeface.
