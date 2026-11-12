import assert from 'node:assert/strict'; // 可直接运行的第二阶段端到端验证。
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'; // 所有破坏测试只作用于临时日志。
import { tmpdir } from 'node:os'; // 使用独立系统临时目录。
import { join } from 'node:path'; // 组合隔离路径。
import { once } from 'node:events'; // 等待真实服务生命周期。
import { randomUUID } from 'node:crypto'; // 生成真实操作编号。
import { loadConfig, createSnapshotReader } from './config.mjs'; // 复用唯一配置与合成来源。
import { createReviewStore, digest } from './review.mjs'; // 验证实际日志实现。
import { createDemoServer } from './server.mjs'; // 验证实际 HTTP 路径。
const config = await loadConfig(), readSnapshot = createSnapshotReader(config); // 无密钥和外部服务。
const directory = await mkdtemp(join(tmpdir(), 'handover-review-smoke-')); // 不触碰用户运行日志。
const sourceBefore = digest(await readSnapshot()); // 检查原始数据未变化。
let server, base, checked = 0; // 统计验证场景。
/** 启动隔离服务；入参无；出参为异步完成；监听失败抛出并由外层清理。 */
async function start() { // 每次创建新的存储实例以模拟重启。
  server = createDemoServer(config, readSnapshot, createReviewStore(config, directory)); // 使用同一个临时日志文件。
  const listening = once(server, 'listening'); server.listen(0, config.server.host); await listening; // 临时回环端口。
  base = 'http://' + config.server.host + ':' + server.address().port; // 不接受外部地址。
} // 结束服务启动。
/** 停止隔离服务；入参无；出参为异步完成；关闭失败抛出，不清理用户服务。 */
async function stop() { // 只管理本脚本创建的服务。
  if (!server?.listening) return; // 已关闭时不再等待事件。
  const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; // 确认端口释放。
} // 结束服务停止。
/** 调用并断言接口；入参为路径、可选输入、身份和预期状态；出参为统一对象；任何差异抛断言。 */
async function request(path, input, identity = 'operator', expected = 200) { // 所有请求到本机。
  const options = { headers: { 'X-Demo-Identity': identity }, signal: AbortSignal.timeout(config.server.requestTimeoutMs) }; // 超时来自唯一配置。
  if (input !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify({ projectId: config.project.projectId, input }); } // 沿用统一业务请求。
  const response = await fetch(base + path, options), envelope = await response.json(); // 不打印输入或日志原文。
  assert.equal(response.status, expected); assert.equal(envelope.ok, expected === 200); assert.equal(typeof envelope.error.code, 'string'); assert.equal(typeof envelope.error.msg, 'string'); // 校验统一结构。
  if (expected !== 200) assert.equal(envelope.data, null); // 错误不得泄露来源。
  checked += 1; return envelope; // 动态统计实际通过的请求。
} // 结束请求验证。
try { // 任意断言失败都关闭临时服务。
  await start(); // 首次启动。
  const created = (await request('/api/run', { identity: 'operator', trainingVersion: 'v2' })).data; // 生成真实持久草稿。
  assert.ok(created.draftId); assert.equal(created.status, 'review'); // 规则通过仍待复核。
  const input = { identity: 'operator', moduleId: config.project.projectId, recordId: config.access.recordId, draftId: created.draftId, expectedRevision: 0, operationId: randomUUID(), opinion: 'acknowledged', reasonCodes: ['evidence-reviewed'], acknowledgement: true }; // 明确模拟人工确认。
  const unconfirmed = await request('/api/reviews', { ...input, acknowledgement: false }, 'operator', 400); assert.equal(unconfirmed.error.code, 'HUMAN_ACK_REQUIRED'); // 未确认不能记录。
  const saved = (await request('/api/reviews', input)).data; assert.equal(saved.revision, 1); assert.equal(saved.approval, '未获人工批准'); // 意见不产生批准。
  const replay = (await request('/api/reviews', input)).data; assert.equal(replay.replayed, true); assert.equal(replay.localAuditWrites, 0); // 重试不重复写入。
  const conflict = await request('/api/reviews', { ...input, operationId: randomUUID() }, 'operator', 409); assert.equal(conflict.error.code, 'REVISION_CONFLICT'); // 旧版本不能覆盖新意见。
  await request('/api/reviews', undefined, 'admin', 403); // 未授权不能读日志。
  const trace = (await request('/api/reviews/history', { identity: 'operator', draftId: created.draftId })).data; // 查询完整追溯。
  assert.equal(trace.reviews.length, 1); assert.equal(trace.sourceHash, digest(trace.result.sources[0].snapshot)); assert.equal(trace.chain.verified, true); // 来源指纹和意见关联成立。
  await stop(); await start(); // 模拟关闭服务后重启。
  const recovered = (await request('/api/reviews/history', { identity: 'operator', draftId: created.draftId })).data; assert.deepEqual(recovered.reviews, trace.reviews); // 重启后意见仍在。
  const second = (await request('/api/reviews', { ...input, operationId: randomUUID(), expectedRevision: 1, opinion: 'escalated', reasonCodes: ['scope-question'] })).data; assert.equal(second.review.previousReviewId, saved.review.reviewId); // 追加意见保留前次关联。
  const list = (await request('/api/reviews')).data; assert.equal(list.drafts[0].revision, 2); // 刷新可恢复最新版本。
  await request('/var/review-events.jsonl', undefined, 'operator', 404); // 日志不能直接下载。
  const log = join(directory, config.review.journalPath); const original = await readFile(log, 'utf8'); await writeFile(log, original + '{'); // 仅损坏临时日志尾行。
  const corrupt = await request('/api/reviews', undefined, 'operator', 503); assert.equal(corrupt.error.code, 'AUDIT_CORRUPT'); // 不把损坏当空历史。
  assert.equal(await readFile(log, 'utf8'), original + '{'); assert.equal(digest(await readSnapshot()), sourceBefore); // 不修剪日志、不改原始来源。
  console.log(JSON.stringify({ ok: true, data: { checked, restartRecovered: true, duplicateSuppressed: true, historyLinked: true, corruptRejected: true, sourceUnchanged: true, writes: 0, externalSends: 0 }, error: { code: '', msg: '' } })); // 仅输出脱敏验证摘要。
} finally { await stop(); await rm(directory, { recursive: true, force: true }); } // 清理脚本自己的日志与端口。
