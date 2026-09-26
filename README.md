# ppter ppt

ppter ppt 是一个开源的本地 PPT 配图工具。你在自己的电脑上说清楚这套演示要讲什么，它用大模型把意图整理成每一页的图片提示词，再逐页生成风格统一的 16:9 图片，并导出可以直接放进汇报的 PPTX。

适合要做宣传册、方案和汇报、但手头没有设计师的人。浏览器就是工作台，提示词、生图和导出都在同一个页面里完成。

项目使用 [MIT 协议](LICENSE)。仓库不包含任何人的 API Key。图片和文本都调用你自己的 [APIMart](https://apimart.ai/zh) 账户，接口说明见 [docs.apimart.ai/cn](https://docs.apimart.ai/cn)。

## 功能讲解

工作台顶部是三步。三步在同一页切换，材料不用先交给另一个聊天网站，再复制回来。

### 1. 写提示词

在这一步说出需求，例如主题、给谁看、大概讲什么。

- 可以选择文本对话模型。当前是 `gpt-5.2-pro` 和 `qwen3.8-max`，请求发往 APIMart 的 [OpenAI Responses](https://docs.apimart.ai/cn/api-reference/texts/openai/responses) 接口。
- 受众、页数、视觉风格或必须保留的事实还不清楚时，模型先用中文追问，一次最多问两个问题，此时不输出整套分页提示词。
- 需求清楚后，点击「生成详细提示词」。每一页是一条独立的图片提示词，页与页之间用单独一行的 `<!-- PAGE -->` 分开。
- 右侧可以预览拆出来的每一页。确认后点击「进入逐页生成」。
- 已经有提示词时，可以展开「粘贴已有提示词」，或点击「导入三页示范」先看完整路径。

### 2. 逐页生成

每一页都能改提示词、调整顺序、删除或新增。也可以上传 JPEG、PNG、WebP 或 GIF 参考图，单张最大 20MB。

视觉风格可选咨询报告、极简发布会、科技企业、温暖插画或自定义。清晰度默认 1K，也可以选 2K 或 4K。画面比例固定 16:9，每页生成 1 张 PNG。

点击「批量生成」后，页面按顺序一张一张提交，避免一次发出大量请求。生成过程中可以继续改其他页。中途关掉浏览器，下次打开会继续查询还没完成的任务。

生图使用 APIMart 的 [GPT Image 2 官方接口](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official)，模型是 `gpt-image-2-official`。写提示词和生图使用同一把 Key。

### 3. 导出 PPTX

有图片之后，进入「导出 PPTX」。主按钮下载演示文稿。同一页也可以下载按页码排列的图片 ZIP，或便于阅读和打印的 PDF。

PPTX 和 PDF 都是整页图片。版式和视觉保持一致，PowerPoint 里的文字不能再单独修改。

### 历史项目

左侧「历史项目」列出这台电脑上保存过的 PPT。点击名称即可切换。每条右侧的删除按钮会去掉该项目的页面、对话和提示词，并删除这个项目结果里引用到的本地图片。正在批量生图时，当前项目不能删除。列表删空后，会留下一条空白项目。

### Key 只留在本机

左侧底部「配置 APIMart」里粘贴自己的 Key。服务只记住「已经配置」，页面上看不到完整 Key。Key 写在本机 `data/config.json`，这个目录不会进入 Git 仓库。空配置示例是 [config.example.json](config.example.json)。

## 开始使用

需要 Node.js 18 或更高版本。安装包在 [Node.js 中文下载页](https://nodejs.org/zh-cn/download)。

| 系统 | 启动方式 |
|------|----------|
| Windows | 解压后双击 `start-server.bat` |
| macOS | 双击 `start-server.command` |
| Linux | 运行 `./start-server.sh` |

第一次启动会安装依赖，需要能访问 npm。启动窗口要保持打开，关掉窗口就会停止服务。浏览器会打开工作台。

从源码启动：

```bash
npm install
npm start
```

默认地址是 `http://127.0.0.1:17890/`。端口被占用时，双击启动器会自动换一个空闲端口。

## 常见问题

| 提示 | 原因 | 处理方式 |
|------|------|----------|
| 请先配置 APIMart API Key | 这台电脑还没有 Key | 在左侧「配置 APIMart」中填写 |
| API Key 无效或已失效 | Key 错误、过期或复制不完整 | 换成有效 Key |
| 余额不足 | 账户额度不够 | 前往 [APIMart](https://apimart.ai/zh) 充值后重试 |
| 请求过于频繁 | 短时间提交过多 | 等一会儿再重试 |
| 无法连接 APIMart | 网络、代理或平台暂时不可用 | 检查网络后重试 |
| 服务暂时异常 | APIMart 返回 5xx | 稍后重试 |

启动器提示依赖安装失败时，先确认能访问 npm，再关闭窗口重新双击。

## 数据放在哪里

| 位置 | 内容 |
|------|------|
| `data/projects.json` | 历史项目，含页面、对话和生成结果 |
| `data/config.json` | 本机 APIMart Key |
| `assets/references/` | 上传的参考图 |
| `ppt_images/` | 已下载到本机的生成图 |

这些目录都在 `.gitignore` 里。换电脑或重新解压前，先备份它们。

## 给自动化使用的命令

普通使用不用打开终端。需要让脚本把分页提示词写入工作台时：

```bash
node scripts/codex-cli.js health
node scripts/codex-cli.js config set --api-key "你的_KEY"
node scripts/codex-cli.js batch --file examples/demo-prompts.txt --name "示范项目" --open
node scripts/codex-cli.js generate --prompt "16:9 科技企业产品架构页" --wait --download
```

`batch` 只把提示词放进工作台，不会跳过确认直接生图。

开发与打包：

```bash
npm test
npm run package:share
```

干净分享包输出到 `dist/ppter-2.1.0-clean.zip`。打包时会检查疑似密钥，并排除 `data/`、`assets/`、`ppt_images/` 和 `node_modules/`。
