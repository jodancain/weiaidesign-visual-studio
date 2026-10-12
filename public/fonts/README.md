# 原工作台完整字体

原来的四个字体 URL 保留，文件替换为各字体家族的官方完整 Regular 字体数据。没有按页面文字做子集化，也没有改名、替换字体家族或修改字形。Smiley Sans 的设计本身为 Oblique，字重由其真实字体文件决定。

| 文件 | 实际字体家族 / 样式 | 来源版本 | Unicode 码位数 | WOFF2 大小 | 来源 | 许可 |
| --- | --- | --- | ---: | ---: | --- | --- |
| lxgw-wenkai.woff2 | LXGW WenKai / Regular | 1.522 | 46,490 | 7.65 MiB | [官方来源](https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf) | [OFL](licenses/wenkai-OFL.txt) |
| source-han-sans.woff2 | Source Han Sans SC / Regular | 2.005 | 44,853 | 11.01 MiB | [官方来源](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf) | [OFL](licenses/sans-OFL.txt) |
| source-han-serif.woff2 | Source Han Serif SC / Regular | 2.003 | 44,779 | 15.94 MiB | [官方来源](https://raw.githubusercontent.com/adobe-fonts/source-han-serif/release/OTF/SimplifiedChinese/SourceHanSerifSC-Regular.otf) | [OFL](licenses/serif-OFL.txt) |
| smiley-sans.woff2 | Smiley Sans Oblique / Regular | 2.0.1 | 9,440 | 1.10 MiB | [官方来源](https://github.com/atelier-anchor/smiley-sans/releases/download/v2.0.1/smiley-sans-v2.0.1.zip) | [OFL](licenses/smiley-OFL.txt) |

合计 35.69 MiB。保留完整字库优先于原来的不完整小文件；不能声称四款字体包含所有 Unicode 字符。实际字符覆盖和已验证样本记录在 [manifest.json](manifest.json)。

## 校验

- 下载来自字体作者或 Adobe Fonts 官方仓库。原始 TTF/OTF、发布包 URL、源文件 SHA256、产物 SHA256、实际家族、PostScript 名称、字重、完整 cmap 数量均有记录。
- 使用项目锁定的 wawoff2 2.0.1（Google WOFF2 WebAssembly）压缩 LXGW WenKai 与 Adobe 两款字体，不做子集化；Smiley 直接使用其官方 ZIP 内的 `SmileySans-Oblique.ttf.woff2`。
- 解压后核对所有 cmap 码位、字形数量、字体名称和 PostScript 身份；136 个测试码位的字形路径与 advanceWidth 和官方原始字体完全一致。
- 测试包含“中文海报”“功能测试”“微爱设计”、文字编辑与印花常用字、中文标点、数字及拉丁字母；四款字体均零缺字。此前四个旧文件在同一样本中均缺失 42 个常用字。
- WOFF2 重建会调整 `head` 校验数据、TTF 的 `glyf/loca` 二进制布局，并移除 Adobe 原文件的空 `DSIG` 签名占位表；字体名称、授权文字、cmap、度量与字形没有被编辑。具体表差异也记录在清单中。

## 再分发

保留每款字体的原始版权声明和完整 OFL 1.1 文本。格式转换遵循 [SIL 官方 OFL FAQ 2.2](https://openfontlicense.org/ofl-faq/#2) 所述的 WOFF/WOFF2 原数据压缩要求。不得把字体单独售卖或将其误称为本项目原创字体。

## SHA256

- `lxgw-wenkai.woff2`: `d12e6fb376fb58d183e4a83dedf7757661eaa3998c2b9da21dbdcfd3b683e989`
- `source-han-sans.woff2`: `24719c32fc42f5eb020a43217c86306cd416a0de18049d7a5c91ff703d9c0290`
- `source-han-serif.woff2`: `04c9ce6314b154e8ca87045a6b86f10a029b07419cb8af9a673a7ccf32deead5`
- `smiley-sans.woff2`: `731f22973349404b15a88a99ef3b5dd4104c0965c23b7e485c1f11e84fea99e2`

既有项目的旧字体资产不可变，更新通过新字体资产和版本记录完成；不能把公开字体文件替换误当作已经修改了旧资产内容。
