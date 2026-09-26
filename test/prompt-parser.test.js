const test = require('node:test');
const assert = require('node:assert/strict');

const PromptParser = require('../public/prompt-parser');

test('PAGE 标记优先于提示词内部空行和其他分隔符', () => {
  const input = '页面类型：封面\r\n标题：第一页\r\n\r\n构图：保留空行\r\n---\r\n仍属于第一页\r\n<!-- PAGE -->\r\n页面类型：总结页\r\n标题：第二页';
  const pages = PromptParser.parse(input);
  assert.equal(pages.length, 2);
  assert.match(pages[0].prompt, /---\n仍属于第一页/);
  assert.equal(pages[1].title, '总结页');
});

test('独占横线可以分页，但代码围栏内横线不会分页', () => {
  const input = '页面类型：观点页\n构图：\n```text\n---\n```\n---\n页面类型：总结页\n标题：结论';
  const pages = PromptParser.parse(input);
  assert.equal(pages.length, 2);
  assert.match(pages[0].prompt, /```text\n---\n```/);
});

test('常见中文页标题可以分页', () => {
  const pages = PromptParser.parse('# 第 1 页：封面\n内容 A\n\n第 二 页 | 价值\n内容 B');
  assert.equal(pages.length, 2);
  assert.match(pages[0].prompt, /第 1 页/);
  assert.match(pages[1].prompt, /第 二 页/);
});

test('重复页面类型字段可作为异常 AI 输出的安全回退', () => {
  const pages = PromptParser.parse('页面类型：封面\n标题：A\n\n页面类型：总结页\n标题：B');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].title, '封面');
  assert.equal(pages[1].title, '总结页');
});

test('单页提示词中的普通空行不会被误拆', () => {
  const pages = PromptParser.parse('标题：单页\n\n核心观点：一件事\n\n构图：左右结构');
  assert.equal(pages.length, 1);
  assert.match(pages[0].prompt, /核心观点/);
});

test('完整代码围栏会被剥离后再解析', () => {
  const pages = PromptParser.parse('```markdown\n页面类型：封面\n<!-- PAGE -->\n页面类型：总结页\n```');
  assert.equal(pages.length, 2);
  assert.doesNotMatch(pages[0].prompt, /```/);
});

test('空输入和连续分隔符只返回有效页面', () => {
  assert.deepEqual(PromptParser.parse('  \r\n '), []);
  const pages = PromptParser.parse('页面类型：封面\n<!-- PAGE -->\n\n<!-- PAGE -->\n页面类型：总结页');
  assert.equal(pages.length, 2);
});
