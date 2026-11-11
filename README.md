# e621 Video Navigator

[简体中文](#简体中文) · [Download v1.8.1](https://github.com/ecl1p5e-quinoa/e621-video-navigator/releases/tag/v1.8.1)

A Chrome and Edge extension for watching videos in the order they appear on an e621 search or favorites page. Open a video from the list and use the shortcuts to move through the visible videos, including in fullscreen.

| Default key | Action |
| --- | --- |
| `]` | Next video |
| `[` | Previous video |
| `→` | Seek forward by 20% of the video's duration |
| `←` | Seek backward by 20% of the video's duration |

All four shortcuts are configurable. The popup lets you choose between looping the current video and automatically playing the next one. **Advanced settings** contains the seek percentages and **Automatic pagination**. When enabled, pagination continues onto the next results page at the end of the queue. The extension skips images and items hidden on the list.

### Install on Chrome or Edge

1. Download and extract the ZIP from [Releases](https://github.com/ecl1p5e-quinoa/e621-video-navigator/releases) to a folder you can keep. If you cloned the repository, use the `extension` directory.
2. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, and select **Load unpacked**.
3. Select the folder containing `manifest.json`. Refresh the search or favorites page, then open a video from that list.

To update, replace the files in the same folder and click **Advanced settings → Apply local update**. This reloads the extension and its open e621 pages. It keeps your settings and interrupts current playback. The button applies files already on disk; it does not download them. An older installation without the button needs one manual reload first.

English is the default. Choose **简体中文** from the **Language / 语言** menu to switch. Your choice is saved locally, along with your shortcuts and video queues. The extension does not require an API key or send your settings to a separate server.

## 简体中文

这是一个电脑端 Chrome / Edge 扩展。它按 e621 搜索结果或收藏页的实际显示顺序切换视频，全屏时也能使用。默认 `]` 下一条、`[` 上一条、`→` 快进 20%、`←` 后退 20%。快捷键可改；百分比和自动翻页在「高级设置」里。「播放结束后」可选择循环重播或自动播放下一条。

1. 从 [Releases](https://github.com/ecl1p5e-quinoa/e621-video-navigator/releases) 下载并解压 ZIP，或使用源码中的 `extension` 目录。
2. 打开 `chrome://extensions` 或 `edge://extensions`，启用「开发者模式」，选择「加载已解压的扩展程序」。
3. 选择含 `manifest.json` 的目录，刷新搜索或收藏页，再从列表进入视频。

更新时先覆盖原目录中的文件，再点「高级设置 → 应用本地更新」。浏览器会重新加载扩展和相关网页，设置保留，当前播放会中断。默认语言为英文，可在弹窗顶部选择简体中文。

### Development

The extension is plain JavaScript, HTML, and CSS. No build step is required. Browser regression tests are in `verify-extension.cjs` and `verify-update.cjs`. They use Playwright and local Chrome/Edge installations with simulated e621 pages. The sample videos in `fixtures` are [Web Platform Tests](https://github.com/web-platform-tests/wpt/tree/master/media) fixtures and retain their [upstream license](fixtures/LICENSE-WPT.md).

This is an unofficial extension and is not affiliated with e621.
