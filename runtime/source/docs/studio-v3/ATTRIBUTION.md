# Studio 3.0 来源与署名

以下依赖使用各自发布包许可。原始许可副本保存在 `licenses/`，构建部署时亦保留 `node_modules` 中对应声明。

| 组件 | 固定版本 | 许可 | 上游 |
|---|---|---|---|
| `@xyflow/react` | 12.12.0 | MIT | https://github.com/xyflow/xyflow.git |
| `@react-three/fiber` | 9.8.1 | MIT | git+https://github.com/pmndrs/react-three-fiber.git |
| `@react-three/drei` | 10.7.9 | MIT | git+https://github.com/pmndrs/drei.git |
| `three` | 0.186.0 | MIT | https://github.com/mrdoob/three.js |
| `@xzdarcy/react-timeline-editor` | 1.0.0 | MIT | git+https://github.com/xzdarcy/react-timeline-editor.git |
| `react-virtualized` | 9.22.6 | MIT | https://github.com/bvaughn/react-virtualized.git |

## 实现与参考

- 画布参考 Open Canvas 的媒体节点及引用方式；未复制其代码、资产或后端。OpenCut Classic 仅作为剪辑交互参考，未嵌入该归档项目。
- 即梦提供的四张截图作为交互与布局验收参考；本项目界面使用自己的名称、图标组件和数据服务。
- 本机 `3D服务车库_SU7_V2.5.zip` 用于参考语义零件身份、受限操作、原子撤销及过期响应保护。当前不打包 SU7 车辆模型、车库材质、HDRI 或配件资产。该包原模型的 CC BY 4.0 条款继续由其 `docs/MODEL-LICENSE.md` 管理；未来复制模型必须一并保留该文件与作者/来源/修改记录。
- 内置灰模角色、基础骨架和 Idle/Walk/Wave/Punch/Kick 动作由本项目程序创建；不冒充外部角色或原厂几何。
- 用户导入 GLB 的来源、许可和派生关系通过 `AssetRevision.source/metadata/parentId` 保留；不可变内容以 SHA-256 关联，场景中的部件身份绑定具体资产版本。

## 代码视频导出与增强（2026-10-02）

- `remotion`、`@remotion/three`、`@remotion/renderer`、`@remotion/bundler` 固定 4.0.532，采用 Remotion 自有许可，**不是 MIT**；许可原文存于 `licenses/remotion-LICENSE.md`。使用者应按随附许可与官方说明核对自身适用资格：https://www.remotion.dev/docs/license/faq 。本服务使用自己的固定 Composition 和受校验的场景数据，不接受上传任意 Remotion 工程代渲染。
- 新增五个风格化角色与三种场景由本项目可信构造器程序创建；场景程序来源、模型原始回执及后续机位/动作修订分开留存，不把工程修订冒充模型一次输出。
- 增强使用社区 DLSSVideoPlayer v0.27.0 的 NR 链路，固定可执行文件及 DLL 哈希，natural / 1 pass / 100%。它不是本项目实现的 NVIDIA 官方 DLSS 5 集成；不把 RTX 3070 的本次实验执行证据解释为官方硬件支持，亦不承诺每个素材观感更好。运行时二进制保留在私有 worker，公网只发布成片。
