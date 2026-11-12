import assert from 'node:assert/strict'; // 验证失败立即非零退出。
import { readFile, mkdir, writeFile } from 'node:fs/promises'; // 仅向显式证据目录写验证产物。
import { createHash } from 'node:crypto'; // 记录源码与数据哈希。
import { spawnSync } from 'node:child_process'; // 使用当前 Node 运行真实测试。
import { resolve, join, sep } from 'node:path'; // 限制证据目录不覆盖源文件。
import { fileURLToPath } from 'node:url'; // 不依赖当前工作目录寻找源码。
import { loadConfig, createSnapshotReader } from './config.mjs'; // 使用唯一运行配置。
import { evaluateProjectDemo } from './runtime.js'; // 使用实际规则评估。
const here = fileURLToPath(new URL('.', import.meta.url)); // 当前源码目录。
const assignment = resolve(here, '..'); // 作业2根目录。
assert.ok(process.argv[2], '用法：node src/verify.mjs ./work-evidence/phase2'); // 明确要求输出位置。
const target = resolve(process.argv[2]); // 证据目录按调用者当前目录解析。
for (const protectedPath of [here, join(assignment, 'docs')]) assert.ok(target !== protectedPath && !target.startsWith(protectedPath + sep), '证据目录不能覆盖源码或历史文档'); // 不改写原始资料和旧证据。
assert.notEqual(target, assignment, '请使用独立证据子目录'); // 不把输出散落到作业根目录。
await mkdir(target, { recursive: true }); // 仅创建用户指定的证据目录。
const config = await loadConfig(); // 配置错误直接失败。
const context = { config, readSnapshot: createSnapshotReader(config) }; // 延迟加载合成数据。
const files = ['config.yaml', 'config.mjs', 'response.mjs', 'data/handover.json', 'runtime.js', 'app.js', 'style.css', 'server.mjs', 'demo.test.mjs', 'server.test.mjs', 'smoke.mjs', 'package.json', 'package-lock.json', 'index.html', 'verify.mjs', 'review.mjs', 'review.test.mjs', 'review-smoke.mjs']; // 第一阶段有效源码清单。
const sourceHashes = {}; // 动态计算哈希，不复制历史值。
for (const file of files) sourceHashes[file] = createHash('sha256').update(await readFile(join(here, file))).digest('hex'); // 保存每份有效文件的指纹。
const suite = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(here, 'demo.test.mjs'), join(here, 'server.test.mjs'), join(here, 'review.test.mjs')], { encoding: 'utf8' }); // 同时运行规则和 HTTP 测试。
await writeFile(join(target, '自动测试日志.txt'), (suite.stdout ?? '') + (suite.stderr ?? '')); // 仅保存测试摘要，不记录业务任务原文。
assert.equal(suite.status, 0, '自动测试失败，请检查输出目录日志'); // 测试失败不生成伪成功证据。
const testCount = Number(suite.stdout.match(/^# tests (\d+)$/m)?.[1]); // 从 TAP 提取实际数量。
assert.ok(testCount > 0, '无法读取测试数量'); // 不继续沿用硬编码 24/24。
const smoke = spawnSync(process.execPath, [join(here, 'smoke.mjs')], { encoding: 'utf8' }); // 自启本机临时服务做端到端验证。
assert.equal(smoke.status, 0, 'HTTP 验证失败'); // 网络和契约失败必须暴露。
const reviewSmoke = spawnSync(process.execPath, [join(here, 'review-smoke.mjs')], { encoding: 'utf8' }); // 验证复核、重启、重试与故障。
assert.equal(reviewSmoke.status, 0, '人工复核端到端验证失败'); // 失败不生成伪成功证据。
const reviewResult = JSON.parse(reviewSmoke.stdout); // 读取实际复核验证摘要。
const smokeResult = JSON.parse(smoke.stdout); // 验证脚本自身输出统一结构。
const rounds = []; // 独立执行五轮确定性评估。
for (let round = 0; round < 5; round += 1) { // 沿用历史五轮验证口径。
  const evaluation = await evaluateProjectDemo(context); // 实际运行场景。
  assert.equal(evaluation.passed, evaluation.total); // 每轮必须全部通过。
  if (round) assert.deepEqual(evaluation, rounds[0]); // 结果不随重复执行变化。
  rounds.push(evaluation); // 保存实际结果。
} // 结束五轮评估。
assert.equal(createHash('sha256').update(await readFile(join(here, config.data.fixturePath))).digest('hex'), sourceHashes[config.data.fixturePath]); // 验证原始数据文件不变。
const result = { assignment: config.project.assignment, phase: 2, generatedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform }, mode: 'offline-fixture', synthetic: true, ruleVersion: config.rules.version, sourceHashes, testExitCode: suite.status, nodeTests: { passed: testCount, total: testCount }, repeatedRounds: rounds.length, deterministic: true, evaluation: rounds[0], smoke: smokeResult.data, reviewSmoke: reviewResult.data, skippedRealActivities: ['真实登录与记录级授权', '真实系统集成', '真实客户UAT', '生产发布', '持久访问审计', '正式人工身份与签名', '模型推理与模型效果评估'] }; // 明确没有执行的真实活动。
await writeFile(join(target, '评估结果.json'), JSON.stringify(result, null, 2) + '\n'); // 新证据不覆盖历史证据。
console.log(JSON.stringify({ ok: true, data: { nodeTests: testCount, evaluation: rounds[0].passed + '/' + rounds[0].total, repeatedRounds: rounds.length, httpChecks: smokeResult.data.checked, reviewChecks: reviewResult.data.checked, output: target }, error: { code: '', msg: '' } })); // 输出可复核摘要。
