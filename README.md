# adb-dsh-plugin

`adb-dsh-plugin` 将本机已有的 Android Debug Bridge（ADB）注册为 DeepSeek Harness 模型工具。插件不启动额外的代理服务，也不在宿主机 shell 中拼接命令；所有 ADB 进程都通过 Harness 的 `ctx.subprocess` 服务启动，并继承工具调用的取消和超时信号。

## 能力

| 工具 | 能力 |
| --- | --- |
| `adb_devices` | 列出设备、连接状态、型号和 transport id |
| `adb_device_info` | 获取 Android 版本、SDK、ABI、屏幕及电池信息 |
| `adb_packages` | 结构化列出应用，可按系统/第三方、启用状态和用户筛选，并返回 APK 路径、版本码、安装来源及 UID |
| `adb_system_services` | 列出 Binder 服务及支持 `dumpsys` 的系统服务 |
| `adb_service_dump` | 读取单个系统服务的有界 `dumpsys` 状态快照 |
| `adb_app_info` | 获取应用版本、APK 路径、权限状态及 activity/service/receiver/provider 组件 |
| `adb_screenshot` | 截屏并通过 Harness 附件服务把 PNG 交给支持图片输入的模型 |
| `adb_ui_hierarchy` | 获取包含文本、resource id、可点击状态和 bounds 的 UI XML；`uiautomator` 不可用时自动读取可见窗口 View 数据；文本模型也可使用 |
| `adb_input` | 点击、滑动、安全 ASCII 文本输入及 keyevent |
| `adb_app` | 列出、安装、启动、停止、清理及卸载应用 |
| `adb_file` | 在会话工作区与设备之间 push/pull 文件或目录 |
| `adb_logcat` | 获取有行数和字节上限的 logcat 快照 |
| `adb_shell` | 执行任意设备侧 shell 命令；默认不注册，需要显式启用 |

未传 `serial` 时，插件依次使用 `defaultSerial` 或唯一一个在线且允许的设备。连接多个在线设备时，模型必须明确传入 serial。

## 本机开发运行

要求与当前 DeepSeek Harness `0.1.0-rc.5` 相同：Node.js `^22.19.0 || >=24`、pnpm，以及 PATH 中可用的 `adb`。

在插件目录安装依赖、检查并构建：

```sh
cd ~/Desktop/side_projects/adb_dsh_plugin
pnpm install
pnpm test
pnpm build
```

已连接并授权一台测试设备时，还可以运行不调用外部模型的本地真机功能测试：

```sh
pnpm test:device
```

它会测试设备发现、设备信息、UI 层级、截图、无副作用按键码、结构化应用信息、权限与四大组件、系统服务、日志，以及一次位于 `/data/local/tmp/adb_dsh_plugin_function_test.txt` 的文件 push/pull 往返；测试结束会自动清理宿主机和设备上的临时文件。请只在允许测试的设备上运行。

有两种加载方式。

### 方式一：源码 overlay

复制开发配置模板，并把其中的插件路径改为本机绝对路径：

```sh
cp cordis.dev.example.yml cordis.dev.yml
```

`cordis.dev.yml` 是包含本机路径和个人权限策略的本地文件，不纳入 Git。配置完成后，先停止已有的 `pnpm dsh web`，再从 Harness 仓库启动：

```sh
cd ~/Desktop/playground/deepseek-harness
pnpm dsh web --patch ~/Desktop/side_projects/adb_dsh_plugin/cordis.dev.yml
```

如果移动了插件目录，需要同步修改 `cordis.dev.yml` 中的绝对路径。

### 方式二：安装为 web profile bundle

构建插件后，从 Harness 源码仓库把本地 checkout 安装到 `web` profile：

```sh
cd ~/Desktop/playground/deepseek-harness
pnpm dsh plugin --profile web add ~/Desktop/side_projects/adb_dsh_plugin
pnpm dsh web
```

`package.json` 中的 `dsh.bundle` 会让 `cordis.patch.yml` 自动加入 profile 的 bundle 层。更新插件代码后重新运行 `pnpm build` 并重启 dsh；bundle 列表发生变化也需要重启。

卸载：

```sh
cd ~/Desktop/playground/deepseek-harness
pnpm dsh plugin --profile web remove adb-dsh-plugin
```

## 配置

在 overlay 的插件行添加 `config` 即可覆盖默认值：

```yaml
- insert:
    - id: adb-tools
      name: '/absolute/path/to/adb_dsh_plugin/src/index.ts'
      config:
        adbPath: adb
        defaultSerial: emulator-5554
        allowedSerials:
          - emulator-5554
        commandTimeoutMs: 30000
        transferTimeoutMs: 180000
        maxOutputBytes: 1048576
        maxScreenshotBytes: 16777216
        processGraceMs: 1000
        enableShell: false
        enableDeviceControl: true
        enableFileTransfer: true
        enableAppManagement: true
        enableDestructiveActions: false
        enableScreenshots: true
        enableUiHierarchy: true
        restrictHostPathsToWorkspace: true
```

`allowedSerials: []` 表示允许所有 ADB 可见设备。`restrictHostPathsToWorkspace: true` 会解析真实路径并拒绝通过绝对路径、`..` 或符号链接访问会话工作区外的宿主机文件。`adb_app` 的 `clear_data` 和 `uninstall` 只有在 `enableDestructiveActions: true` 时才执行。

`adb_packages`、`adb_system_services`、`adb_service_dump` 和 `adb_app_info` 都是只读工具，不依赖 `enableShell` 或 `enableAppManagement`。`adb_app_info` 默认返回适合模型直接使用的结构化字段；确实需要 Package Manager 的其他细节时，可传 `includeRawDump: true`，原始输出仍受 `maxOutputBytes` 限制并通过 `truncated` 标记截断。

## 验证提示词

连接并授权设备后，可在 Web UI 中依次尝试：

```text
调用 adb_devices 列出设备，然后读取唯一在线设备的系统、屏幕和电池信息。
```

```text
调用 adb_packages 列出第三方应用，返回每个应用的包名、版本码、安装来源和 APK 路径，不要修改设备。
```

```text
调用 adb_app_info 查看 com.example.app：汇总申请的权限及其授权状态，并分别列出 activity、service、broadcast receiver 和 content provider。
```

```text
先用 adb_system_services 查找 package 服务，再用 adb_service_dump 查看它的当前状态，只做读取。
```

```text
使用 adb_ui_hierarchy 查看当前界面，找到文本为“设置”的可点击节点并告诉我它的 bounds，先不要点击。
```

图片模型还可以使用：

```text
调用 adb_screenshot 查看当前设备屏幕并描述界面，不要执行任何点击。
```

## 安全说明

ADB 授权本身给予主机对设备的高权限控制。Harness 的宿主机文件沙箱不会限制设备侧的点击、应用管理或 `adb shell` 副作用，因此生产环境应设置 `allowedSerials`，保留工作区路径限制，并只启用确实需要的工具。任意 shell 和清理/卸载应用默认关闭。

截图只有在当前模型明确声明支持图片输入且 Harness 已挂载附件服务时才会执行；否则工具会提示改用 `adb_ui_hierarchy`。UI 层级优先使用无障碍树；当设备的 `uiautomator` 返回空树时，会回退到 Android WindowManager 的可见原生 View 层级。该回退路径无法保证包含 Jetpack Compose/WebView 内部的完整语义，必要时应结合截图判断。输出超限时只保留有界结果并明确标记截断。
