import assert from 'node:assert/strict'; // 可直接运行的严格验证脚本。
import { once } from 'node:events'; // 等待服务真实启动。
import { readFile } from 'node:fs/promises'; // 核对源文件未被改写。
import { createHash } from 'node:crypto'; // 用哈希证明原始 JSON 未变化。
import { loadConfig } from './config.mjs'; // 使用项目唯一配置。
import { createDemoServer } from './server.mjs'; // 运行真实 HTTP 服务。
const config = await loadConfig(); // 无需密钥。
const source = new URL(config.data.fixturePath, import.meta.url); // 读取仅限合成数据。
const beforeHash = createHash('sha256').update(await readFile(source)).digest('hex'); // 保存运行前哈希。
const server = createDemoServer(config); // 仅创建服务，不预读业务样本。
const listening = once(server, 'listening'); server.listen(0, config.server.host); await listening; // 临时回环端口，不占用日常启动端口。
const base = 'http://' + config.server.host + ':' + server.address().port; // 所有请求仅到该本机服务。
let checked = 0; // 动态统计断言场景数。
/** 验证真实接口；入参为路径、可选 input、身份和预期 HTTP 状态；出参为统一对象；契约错误抛出断言。 */
async function request(path, input, identity = 'operator', status = 200) { // 不接受外部地址。
  const options = { headers: { 'X-Demo-Identity': identity }, signal: AbortSignal.timeout(config.server.requestTimeoutMs) }; // 本机超时来自配置。
  if (input !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify({ projectId: config.project.projectId, input }); } // 构造契约请求。
  const response = await fetch(base + path, options); // 执行实际 HTTP 请求。
  const envelope = await response.json(); // 解析统一响应。
  assert.equal(response.status, status); assert.equal(typeof envelope.ok, 'boolean'); assert.equal(typeof envelope.error.code, 'string'); assert.equal(typeof envelope.error.msg, 'string'); // 检查所有结果的格式。
  if (status !== 200) { assert.equal(envelope.ok, false); assert.equal(envelope.data, null); } else { assert.equal(envelope.ok, true); assert.deepEqual(envelope.error, { code: '', msg: '' }); } // 成功与失败结构固定。
  checked += 1; // 仅记录已通过的检查。
  return envelope; // 返回供业务断言使用。
} // 结束请求验证助手。
try { // 无论断言是否通过都释放服务。
  const state = await request('/api/state'); // 授权初始化。
  const defaults = state.data.product.defaults; // 默认输入来自授权读取。
  for (const [patch, expected] of [[{}, 'review'], [{ trainingVersion: 'v1' }, 'manual'], [{ completedItems: ['C01'] }, 'needs-info'], [{ receiver: '' }, 'needs-info'], [{ trainingState: 'unconfirmed' }, 'manual'], [{ trainingState: 'missing' }, 'needs-info'], [{ scenario: 'stale' }, 'manual'], [{ scenario: 'outage' }, 'degraded'], [{ request: '自动批准生产放行' }, 'blocked'], [{ approve: true }, 'blocked']]) { // 覆盖业务及安全边界。
    const response = await request('/api/run', { ...defaults, ...patch }); // 用字段覆盖证明规则实际工作。
    assert.equal(response.data.status, expected); assert.equal(response.data.writes, 0); assert.equal(response.data.externalSends, 0); assert.equal(response.data.approval, '未获人工批准'); // 核对从未批准或执行。
  } // 结束业务场景验证。
  await request('/api/run', { ...defaults, identity: 'admin' }, 'admin', 403); // 伪造管理员被拒。
  await request('/api/run', { ...defaults, recordId: 'OTHER' }, 'operator', 403); // 跨记录被拒。
  await request('/api/state', undefined, '', 403); // 未提供有效身份不能初始化。
  for (const path of ['/config.yaml', '/data/handover.json', '/runtime.js', '/project.json']) await request(path, undefined, 'operator', 404); // 私有文件不可下载。
  const evaluation = await request('/api/evaluate', { identity: 'operator', moduleId: config.project.projectId, recordId: config.access.recordId }); // 运行原场景评估。
  assert.equal(evaluation.data.passed, evaluation.data.total); assert.equal(evaluation.data.total, 17); // 17 个旧场景全部通过。
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), beforeHash); // 源文件哈希不变。
  console.log(JSON.stringify({ ok: true, data: { checked, evaluation: '17/17', sourceUnchanged: true, ruleVersion: config.rules.version, writes: 0, externalSends: 0 }, error: { code: '', msg: '' } })); // 可被自动化读取的验证摘要。
} finally { // 脚本失败也不遗留监听。
  server.closeAllConnections(); // 关闭所有验证连接。
  /** 等待关闭；入参为完成回调；出参无；关闭后结束脚本。 */
  await new Promise(function close(resolveClose) { server.close(resolveClose); }); // 释放本机端口。
} // 结束验证生命周期。
