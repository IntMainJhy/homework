import test from 'node:test'; // 原生复核与持久追溯测试。
import assert from 'node:assert/strict'; // 原生严格断言。
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises'; // 只操作隔离测试目录。
import { tmpdir } from 'node:os'; // 临时文件位置。
import { join } from 'node:path'; // 组合路径。
import { randomUUID } from 'node:crypto'; // 真实幂等操作编号。
import { once } from 'node:events'; // 测试真实服务生命周期。
import { loadConfig, createSnapshotReader } from './config.mjs'; // 原有配置和合成来源。
import { runProjectDemo } from './runtime.js'; // 草稿来自实际规则。
import { createReviewStore, validateReview, digest, reviewError } from './review.mjs'; // 实际审计实现。
import { createDemoServer } from './server.mjs'; // 完整 HTTP 验证。
const config = await loadConfig(), sourceReader = createSnapshotReader(config); // 使用唯一配置。
/** 建立隔离环境；入参为测试上下文和可选配置；出参为目录、日志及存储；失败由测试报告并清理。 */
async function fixture(t, custom = config) { // 不触碰 src/var 或原始样本。
  const directory = await mkdtemp(join(tmpdir(), 'handover-review-')); // 每个测试独立日志。
  /** 清理测试数据；入参无；出参为删除 Promise；失败由测试报告。 */
  async function cleanup() { await rm(directory, { recursive: true, force: true }); } // 不清理用户运行记录。
  t.after(cleanup); // 无论断言是否成功均清理。
  return { directory, path: join(directory, custom.review.journalPath), store: createReviewStore(custom, directory) }; // 返回显式环境。
} // 结束环境创建。
/** 生成可记录草稿；入参为存储；出参为持久草稿摘要；规则和存储失败抛出。 */
async function draft(store) { // 不手写假结论。
  const result = await runProjectDemo(config.project.projectId, { identity: 'operator' }, { config, readSnapshot: sourceReader }); // 运行真实规则。
  return store.recordDraft(result, { trainingVersion: 'v2' }); // 只记录已校验的合成覆盖。
} // 结束草稿生成。
/** 构造规范意见；入参为草稿摘要与可选覆盖；出参为规范命令；无效覆盖抛出受控错误。 */
function command(created, patch = {}) { // 显式勾选确认，而非由服务自动授予。
  return validateReview(config, { identity: 'operator', draftId: created.draftId, expectedRevision: 0, operationId: randomUUID(), opinion: 'acknowledged', reasonCodes: ['evidence-reviewed'], acknowledgement: true, ...patch }); // 每个意见绑定已读版本。
} // 结束命令构造。
/** 验证延迟建目录；入参为测试上下文；出参为异步完成；预读或预写即失败。 */
test('复核：存储创建不创建目录，首次查询返回验证后的空历史', async function lazyStore(t) { // 未授权请求不能因构造对象而读日志。
  const env = await fixture(t); // 仅创建测试根目录。
  await assert.rejects(stat(join(env.directory, 'var')), { code: 'ENOENT' }); // 存储构造没有副作用。
  const list = await env.store.list(); assert.equal(list.drafts.length, 0); assert.equal(list.chain.verified, true); // 首次空日志合法。
}); // 结束延迟测试。
/** 验证持久历史；入参为测试上下文；出参为异步完成；重启丢失或旧意见被覆盖即失败。 */
test('复核：两次意见追加关联，重建存储仍保留原始草稿与历史', async function durableHistory(t) { // 核心持久化验收。
  const env = await fixture(t), created = await draft(env.store); // 保存真实草稿。
  const first = await env.store.recordReview(command(created), sourceReader); // 首次人工意见。
  const second = await env.store.recordReview(command(created, { expectedRevision: 1, opinion: 'escalated', reasonCodes: ['scope-question'] }), sourceReader); // 追加新意见。
  const history = await createReviewStore(config, env.directory).history(created.draftId); // 模拟服务重启后重新读取。
  assert.equal(history.revision, 2); assert.equal(history.reviews[0].reviewId, first.review.reviewId); assert.equal(second.review.previousReviewId, first.review.reviewId); // 旧记录仍可定位。
  assert.equal(history.result.status, 'review'); assert.equal(history.approval, '未获人工批准'); assert.equal(history.reviewStatus, 'opinion-recorded'); // 意见不改变批准状态。
  assert.equal(history.resultHash, digest(history.result)); assert.equal(history.sourceHash, digest(history.result.sources[0].snapshot)); assert.equal(history.chain.eventCount, 3); // 指纹关联完整。
}); // 结束持久历史测试。
/** 验证人工确认输入；入参为测试上下文；出参为异步完成；未确认或越权内容落盘即失败。 */
test('复核：必须显式确认，拒绝批准、自由文字和伪造时间字段', async function explicitAcknowledgement(t) { // 人工确认不能默认勾选。
  const env = await fixture(t), created = await draft(env.store); const before = await readFile(env.path, 'utf8'); // 保存输入校验前日志。
  for (const patch of [{ acknowledgement: false }, { acknowledgement: 'true' }, { acknowledgement: undefined }, { opinion: 'approved' }, { reasonCodes: ['真实姓名'] }, { notes: '不能入库的自由文字' }, { createdAt: '伪造时间' }, { expectedRevision: -1 }, { reasonCodes: [] }, { reasonCodes: ['evidence-reviewed', 'evidence-reviewed'] }]) { // 逐项覆盖边界。
    /** 拒绝无效命令；入参无；出参为异常；任何通过都会触发断言。 */
    function invalid() { command(created, patch); } // 不触发存储。
    assert.throws(invalid); // 必须明确拒绝。
  } // 结束无效命令验证。
  await assert.rejects(env.store.recordReview({ ...command(created), acknowledgement: false }, sourceReader), { code: 'HUMAN_ACK_REQUIRED' }); // 存储入口也不能绕过人工确认。
  assert.equal(await readFile(env.path, 'utf8'), before); // 未落盘任何意见。
}); // 结束人工输入测试。
/** 验证幂等；入参为测试上下文；出参为异步完成；重复事件或编号复用未拒绝即失败。 */
test('复核：同一操作重试不重复追加，改内容复用编号返回冲突', async function idempotency(t) { // 网络响应丢失后可安全重试。
  const env = await fixture(t), created = await draft(env.store), input = command(created); // 固定一次操作编号。
  const first = await env.store.recordReview(input, sourceReader); const bytes = await readFile(env.path, 'utf8'); // 已确认保存。
  /** 不应再读当前来源；入参无；出参为异常；已保存操作重放不依赖新来源。 */
  async function unavailable() { throw new Error('来源不应重读'); } // 模拟重试时来源故障。
  const replayed = await env.store.recordReview(input, unavailable); // 只读取已验证日志中的原操作。
  assert.equal(replayed.replayed, true); assert.equal(replayed.localAuditWrites, 0); assert.equal(replayed.review.reviewId, first.review.reviewId); assert.equal(await readFile(env.path, 'utf8'), bytes); // 不追加第二行。
  await assert.rejects(env.store.recordReview({ ...input, opinion: 'escalated' }, sourceReader), { code: 'IDEMPOTENCY_CONFLICT' }); // 不把不同意见当成同一重试。
}); // 结束幂等测试。
/** 验证并发版本；入参为测试上下文；出参为异步完成；同一版本被两次接受即失败。 */
test('复核：并发提交同一期望版本仅一条成功，另一条要求刷新', async function optimisticRevision(t) { // 保留每位操作者看到的版本关系。
  const env = await fixture(t), created = await draft(env.store); // 同一份待复核草稿。
  const results = await Promise.allSettled([env.store.recordReview(command(created), sourceReader), env.store.recordReview(command(created), sourceReader)]); // 两个独立操作竞争同一版本。
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.code, 'REVISION_CONFLICT'); // 不静默覆盖。
  assert.equal((await env.store.history(created.draftId)).revision, 1); // 只保存一个新意见。
}); // 结束并发版本测试。
/** 验证来源变化；入参为测试上下文；出参为异步完成；旧草稿被当作当前来源确认即失败。 */
test('复核：来源或规则变化后拒绝旧草稿新增意见，历史仍可查看', async function staleDraft(t) { // 原始来源及规则版本必须绑定。
  const env = await fixture(t), created = await draft(env.store); // 保存原版来源指纹。
  /** 读取变更副本；入参无；出参为有效但不同的合成来源；文件失败抛出。 */
  async function changedSource() { return { ...await sourceReader(), trainingVersion: 'v1' }; } // 不修改真实 fixture。
  await assert.rejects(env.store.recordReview(command(created), changedSource), { code: 'DRAFT_STALE' }); // 来源变化不能继续。
  const changedConfig = structuredClone(config); changedConfig.rules.version = 'test-next-rule'; // 模拟服务升级。
  await assert.rejects(createReviewStore(changedConfig, env.directory).recordReview(command(created), sourceReader), { code: 'DRAFT_STALE' }); // 规则升级也要重跑。
  assert.equal((await env.store.history(created.draftId)).reviews.length, 0); // 仍可读历史，不伪造意见。
}); // 结束来源绑定测试。
/** 验证来源故障；入参为测试上下文；出参为异步完成；来源不可用却记录意见即失败。 */
test('复核：当前来源不可用时不使用历史快照补确认', async function unavailableSource(t) { // 故障必须停在人工处理边界。
  const env = await fixture(t), created = await draft(env.store); // 已有合法草稿。
  /** 故障读取；入参无；出参为异常；不提供假快照。 */
  async function failedReader() { throw new Error('内部敏感异常'); } // 合成故障。
  await assert.rejects(env.store.recordReview(command(created), failedReader), { code: 'SOURCE_UNAVAILABLE' }); // 不能靠旧快照通过。
  assert.equal((await env.store.history(created.draftId)).revision, 0); // 不追加任何意见。
}); // 结束来源故障测试。
/** 验证日志损坏；入参为测试上下文；出参为异步完成；损坏被隐藏、截断或继续追加即失败。 */
test('复核：改写历史内容后查询和追加均拒绝，不自动修复文件', async function tamperedJournal(t) { // 哈希链用于检测可见历史变化。
  const env = await fixture(t), created = await draft(env.store); // 初始日志。
  const changed = (await readFile(env.path, 'utf8')).replace('交接核对草稿，待人工复核', '篡改后的草稿'); await writeFile(env.path, changed); // 只改测试日志。
  await assert.rejects(env.store.history(created.draftId), { code: 'AUDIT_CORRUPT' }); // 不返回被改写记录。
  await assert.rejects(env.store.recordReview(command(created), sourceReader), { code: 'AUDIT_CORRUPT' }); // 不追加到坏链上。
  assert.equal(await readFile(env.path, 'utf8'), changed); // 不偷偷截断或重写。
}); // 结束篡改检测测试。
/** 验证半行与删除；入参为测试上下文；出参为异步完成；故障被当作空记录即失败。 */
test('复核：半写尾行及本运行内整文件丢失均明确拒绝', async function incompleteJournal(t) { // 防止崩溃后假装没有历史。
  const env = await fixture(t), created = await draft(env.store); const before = await readFile(env.path, 'utf8'); // 保存合法日志。
  await writeFile(env.path, before + '{'); // 模拟断电留下半行。
  await assert.rejects(createReviewStore(config, env.directory).list(), { code: 'AUDIT_CORRUPT' }); // 重启也能发现不完整尾行。
  await rm(env.path); // 模拟同运行期间删除文件。
  await assert.rejects(env.store.history(created.draftId), { code: 'AUDIT_CORRUPT' }); // 本运行已见链头不能无声回退。
}); // 结束完整性故障测试。
/** 验证容量限额；入参为测试上下文；出参为异步完成；满额仍写入或自动删历史即失败。 */
test('复核：事件或字节限额到达后失败，保留旧记录', async function storageLimits(t) { // 日志没有自动删除或轮转能力。
  const limited = structuredClone(config); limited.review.maxEvents = 1; const env = await fixture(t, limited), created = await draft(env.store); // 一条草稿即满。
  const before = await readFile(env.path, 'utf8'); // 保存旧记录。
  await assert.rejects(env.store.recordReview(command(created), sourceReader), { code: 'AUDIT_LIMIT' }); // 不能再追加。
  assert.equal(await readFile(env.path, 'utf8'), before); // 旧历史不变。
  const tiny = structuredClone(config); tiny.review.maxJournalBytes = 1; const small = await fixture(t, tiny); // 独立字节限额测试。
  await assert.rejects(draft(small.store), { code: 'AUDIT_LIMIT' }); // 草稿无法完整保存时明确失败。
}); // 结束容量测试。
/** 验证文件锁；入参为测试上下文；出参为异步完成；已有锁被抢走或自动删除即失败。 */
test('复核：遇到其他实例或遗留锁时失败且保留锁', async function exclusiveLock(t) { // 不以自动删锁掩盖并发风险。
  const env = await fixture(t); await mkdir(join(env.directory, 'var')); await writeFile(env.path + '.lock', '其他实例'); // 模拟外部持有锁。
  await assert.rejects(env.store.list(), { code: 'AUDIT_BUSY' }); // 明确告知稍后处理。
  assert.equal(await readFile(env.path + '.lock', 'utf8'), '其他实例'); // 不能删除别人的锁。
}); // 结束文件锁测试。
/** 验证未知草稿与只读结果；入参为测试上下文；出参为异步完成；未知草稿创建意见或污染原结果即失败。 */
test('复核：未知草稿拒绝，调用者修改历史对象不影响持久内容', async function isolatedHistory(t) { // 读投影与日志隔离。
  const env = await fixture(t), created = await draft(env.store); // 有效草稿。
  await assert.rejects(env.store.history(randomUUID()), { code: 'DRAFT_NOT_FOUND' }); // 不能凭客户端编号造草稿。
  const view = await env.store.history(created.draftId); view.result.approval = '客户端伪造'; // 修改调用者自己的副本。
  assert.equal((await env.store.history(created.draftId)).result.approval, '未获人工批准'); // 重新读取仍为原始结果。
}); // 结束投影隔离测试。
/** 创建测试 HTTP 服务；入参为测试上下文、来源读取器和复核存储；出参为本机请求函数；清理失败由测试报告。 */
async function httpFixture(t, reader = sourceReader, store) { // 不把任何日志挂到静态路由。
  const server = createDemoServer(config, reader, store); const listening = once(server, 'listening'); server.listen(0, config.server.host); await listening; // 隔离端口。
  /** 关闭测试服务；入参无；出参为完成 Promise；释放所有测试连接。 */
  async function cleanup() { const closed = once(server, 'close'); server.closeAllConnections(); server.close(); await closed; } // 不留下端口。
  t.after(cleanup); // 任何测试路径都关闭服务。
  const base = 'http://' + config.server.host + ':' + server.address().port; // 禁止外部地址。
  /** 请求本地 API；入参为路径、可选任务及演示身份；出参为真实 HTTP 状态与外壳；网络故障抛出。 */
  async function call(path, input, identity = 'operator') { // 仅测试标准 JSON 契约。
    const options = { headers: { 'X-Demo-Identity': identity } }; // 演示身份仍可自报。
    if (input !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify({ projectId: config.project.projectId, input }); } // 统一业务请求结构。
    const response = await fetch(base + path, options); return { status: response.status, body: await response.json() }; // 返回实际接口结果。
  } // 结束请求函数。
  return call; // 只暴露本机请求能力。
} // 结束 HTTP 环境创建。
/** 验证权限顺序；入参为测试上下文；出参为异步完成；未授权调用存储或读取器即失败。 */
test('复核 HTTP：身份、跨记录及未确认输入先拒绝，存储与来源零调用', async function reviewAuthorization(t) { // 权限校验先于日志与来源读取。
  let reads = 0, calls = 0; // 分别统计两类敏感读取。
  /** 禁止来源读取；入参无；出参为异常；调用即计数。 */
  async function noRead() { reads += 1; throw new Error('不该读源'); } // 不使用实际资料。
  /** 禁止审计操作；入参无；出参为异常；调用即计数。 */
  async function noStore() { calls += 1; throw new Error('不该读日志'); } // 存储间谍。
  const call = await httpFixture(t, noRead, { list: noStore, history: noStore, recordDraft: noStore, recordReview: noStore }); // 注入两个拒绝间谍。
  assert.equal((await call('/api/reviews', undefined, 'admin')).status, 403); // 列表无权限。
  assert.equal((await call('/api/reviews/history', { identity: 'admin', draftId: randomUUID() }, 'admin')).status, 403); // 历史无权限。
  assert.equal((await call('/api/reviews', { identity: 'operator', recordId: 'OTHER' })).status, 403); // 跨记录意见。
  const response = await call('/api/reviews', { identity: 'operator', draftId: randomUUID(), operationId: randomUUID(), expectedRevision: 0, opinion: 'acknowledged', reasonCodes: ['evidence-reviewed'], acknowledgement: false }); // 没有人工确认。
  assert.equal(response.status, 400); assert.equal(response.body.error.code, 'HUMAN_ACK_REQUIRED'); assert.equal(response.body.data, null); // 统一错误且不落盘。
  assert.equal(reads, 0); assert.equal(calls, 0); // 真实调用次数均为零。
}); // 结束权限顺序测试。
/** 验证完整接口；入参为测试上下文；出参为异步完成；状态、追溯或静态保护不符即失败。 */
test('复核 HTTP：保存草稿、意见、查询、导出结构及私有文件边界', async function fullReviewHttp(t) { // 运行真实存储和服务。
  const env = await fixture(t), call = await httpFixture(t, sourceReader, env.store); // 独立日志。
  const run = await call('/api/run', { identity: 'operator' }); assert.equal(run.status, 200); assert.ok(run.body.data.draftId); // 草稿实际落盘。
  const input = { identity: 'operator', ...command(run.body.data) }; // 与页面相同的明确确认命令。
  const saved = await call('/api/reviews', input); assert.equal(saved.body.data.revision, 1); assert.equal(saved.body.data.approval, '未获人工批准'); // 记录不是批准。
  const replayed = await call('/api/reviews', input); assert.equal(replayed.body.data.replayed, true); // HTTP 重试幂等。
  const history = await call('/api/reviews/history', { identity: 'operator', draftId: input.draftId }); // 查询完整历史。
  assert.equal(history.body.data.reviews.length, 1); assert.equal(history.body.data.chain.verified, true); assert.equal(history.body.data.result.status, 'review'); // 来源与原状态保留。
  assert.equal((await call('/api/reviews')).body.data.drafts[0].revision, 1); // 刷新可恢复摘要。
  for (const path of ['/var/review-events.jsonl', '/var/review-events.jsonl.lock', '/review.mjs']) { const denied = await call(path); assert.equal(denied.status, 404); assert.equal(denied.body.data, null); } // 不能绕过权限下载文件。
}); // 结束完整接口测试。
/** 验证保存故障；入参为测试上下文；出参为异步完成；保存失败仍返回成功即失败。 */
test('复核 HTTP：日志写入失败返回 503，不伪造已保存草稿', async function failedPersistence(t) { // API 必须区分运行完成和审计保存成功。
  /** 故障存储；入参无；出参为异常；不实际写日志。 */
  async function failedStore() { throw reviewError('AUDIT_UNAVAILABLE', 503, '复核日志读写失败，未确认保存成功'); } // 不回显敏感系统异常。
  const call = await httpFixture(t, sourceReader, { recordDraft: failedStore }); // 只会调用该方法。
  const response = await call('/api/run', { identity: 'operator' }); // 正常规则也可能遇到保存失败。
  assert.equal(response.status, 503); assert.equal(response.body.ok, false); assert.equal(response.body.data, null); assert.equal(response.body.error.code, 'AUDIT_UNAVAILABLE'); // 不返回可误解的成功草稿。
}); // 结束持久故障测试。
