# bingbing

DeepSeek Harness 的一个插件，改的是系统提示词那一层：把自己写的三段 prompt 塞进去，
顺手把宿主自己写的审批句、沙箱句和身份段换掉。

![开关台](docs/panel.jpg)

## 它改了什么

Harness 每轮组装系统提示词时会走 `system-prompt/assemble`。插件挂在两个地方：

1. `systemPrompt.section()` 注册三段：前段（环境事实）、正文、尾段（硬约束，排在最后说话）。
2. 同一个 waterfall 里，把 `approval:policy`、`sandbox:policy` 的文本换成"已授权"版本，
   再删掉 `*identity*` 段。段名和位置都留着，装配出来结构跟官方一样，只是内容不同。

正文默认读 `~/.dsh/prompt-inject.md`，没有就用包里自带的（`prompts/v1/`）。

## 装

要 Node 18+，并且 Harness 已经装好、启动过一次。

```
node bin\bingbing.js install
```

不想开命令行就双击 `install.cmd`。装完托盘退出 Harness 再打开，
输入框右边会多一个「越狱」按钮。

自检：

```
node bin\bingbing.js doctor
```

## 用

点「越狱」出面板。上面四个预设一键切：旧越狱 / 当前越狱 / 机制内核 / 关闭。
切换只写 `state/bingbing/override.json`，下一轮组装就生效，不用重启。

右边是证据表：左边是当前配置应该产生的段，右边是上一次组装实际拿到的段，
逐项比字节数和 sha256，不靠"看起来对"。

「版本」区可以检查更新、切到某个版本、回滚。命令行也能做：

```
node bin\bingbing.js update check
node bin\bingbing.js update install latest
node bin\bingbing.js update switch 0.10.2
node bin\bingbing.js update rollback
```

切完版本要重启一次（lib 是 ESM，进程里换不掉）。重启脚本在
`state/bingbing/restart.cmd`，面板上点「重启」也会生成它。

## 版本是怎么切的

profile 里 `node_modules/bingbing` 指向 `state/bingbing/current`，`current` 是个 junction。
新版本下载后解包到 `state/bingbing/versions/<版本>/`，切版本只改 `current` 指向哪里，
不动 profile、不跑 pnpm。

切完写 `pending.json`，重启 60 秒后跑一遍静态探针：过了就确认，没过就自动切回上一版。

## 目录

```
bin/      命令行（install / doctor / update / 独立网页版）
lib/      插件本体，l0/ 是提示词层，update/ 是版本与更新
ui/       独立网页版面板
prompts/  三段 shell 和内置正文
tests/    自测（41 条）
tools/    打包和验收脚本
docs/     截图
```

## 几点说明

- 只写 `$DSH_HOME` 和 profile 目录，不碰 Harness 安装目录，不解 `app.asar`。
- `prompts/` 是每次组装现读磁盘的，改完下一轮生效；改 `lib/` 要重启。
- 只在 Windows + Harness 0.2.x 桌面版上试过，junction 和 `.cmd` 都是 Windows 的。
- 早期参考过 dsh-purge 的思路，署名写在 [NOTICE](NOTICE)。
- MIT
