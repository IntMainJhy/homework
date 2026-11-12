import { open, mkdir, realpath, unlink, constants } from 'node:fs/promises'; // 使用原生文件日志，不引入数据库。
import { dirname, resolve } from 'node:path'; // 限定本地审计位置。
import { createHash, randomUUID } from 'node:crypto'; // 原生哈希及唯一编号。
import { CONFIG_PATH, isObject } from './config.mjs'; // 共享唯一配置及对象检查。
import { getDemoProduct } from './runtime.js'; // 重放时验证来源仍符合合成契约。
export const opinions = [['acknowledged', '已人工核阅资料'], ['needs-info', '要求补充资料'], ['escalated', '转人工协调']]; // 记录意见，不包含通过或放行。
export const reasons = [['evidence-reviewed', '已查看本草稿证据'], ['version-conflict', '版本存在冲突'], ['missing-record', '资料或检查项缺失'], ['open-exception', '仍有未结异常'], ['source-stale', '来源时效需核实'], ['scope-question', '适用范围需人工确认']]; // 预定义中文意见，避免保存个人信息。
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i; // 仅接受 UUID v4。
const genesis = '0'.repeat(64); // 明确哈希链的起点，不含秘密。
/** 计算结构哈希；入参为可序列化对象；出参为 SHA-256；序列化失败向调用者抛出。 */
export function digest(value) { // 哈希只用于一致性检测，不能作为人员签名。
  return createHash('sha256').update(JSON.stringify(value)).digest('hex'); // 固定 UTF-8 JSON 编码。
} // 结束哈希计算。
/** 构造复核错误；入参为错误码、HTTP 状态和中文信息；出参为 Error；不携带原始日志内容。 */
export function reviewError(code, status, message) { // 交由统一 HTTP 外壳处理。
  return Object.assign(new Error(message), { code, status }); // 只公开固定错误信息。
} // 结束错误构造。
/** 比较对象字段；入参为对象和字段数组；出参为布尔值；未知或缺失字段返回 false。 */
function exactKeys(value, keys) { // 防止日志或请求混入自由文字及权限字段。
  if (!isObject(value) || Object.keys(value).length !== keys.length) return false; // 数组、空值和额外字段均拒绝。
  for (const key of keys) if (!Object.hasOwn(value, key)) return false; // 每个必需字段都存在。
  return true; // 字段集合恰好匹配。
} // 结束字段集合检查。
/** 校验复核意见输入；入参为配置和任务；出参为脱离原对象的规范命令；失败抛出 400，不保存原文。 */
export function validateReview(config, input) { // 人工确认必须明确，不能自动勾选。
  const allowed = ['identity', 'moduleId', 'recordId', 'draftId', 'expectedRevision', 'operationId', 'opinion', 'reasonCodes', 'acknowledgement']; // 仅允许结构化意见。
  if (!isObject(input)) throw reviewError('INVALID_REVIEW', 400, '复核意见必须是对象'); // 不隐式转换类型。
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw reviewError('INVALID_REVIEW', 400, '复核不接受自由文字、批准或未知字段'); // 防止保存真实人员信息和越权动作。
  if (typeof input.draftId !== 'string' || !uuid.test(input.draftId) || typeof input.operationId !== 'string' || !uuid.test(input.operationId)) throw reviewError('INVALID_REVIEW', 400, '草稿编号或操作编号无效'); // 编号由服务端或浏览器安全生成。
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw reviewError('INVALID_REVIEW', 400, '必须提供非负的已读取意见版本'); // 不能覆盖尚未看到的新意见。
  if (input.acknowledgement !== true) throw reviewError('HUMAN_ACK_REQUIRED', 400, '请人工勾选已查看草稿且理解记录意见不会批准或放行'); // 缺失、字符串 true 和自动默认值均不算人工确认。
  let validOpinion = false; // 明确限制意见类型。
  for (const [id] of opinions) if (input.opinion === id) validOpinion = true; // 不提供 approve 或 release 枚举。
  if (!validOpinion) throw reviewError('INVALID_REVIEW', 400, '仅允许已核阅、要求补充或转人工协调'); // 意见不能改变业务权限。
  if (!Array.isArray(input.reasonCodes) || !input.reasonCodes.length || input.reasonCodes.length > config.review.maxReasons || new Set(input.reasonCodes).size !== input.reasonCodes.length) throw reviewError('INVALID_REVIEW', 400, '请选择限额内且不重复的复核原因'); // 不自动补造意见。
  for (const code of input.reasonCodes) { // 每个原因均须匹配白名单。
    let validReason = false; // 不接受任意描述文字。
    for (const [id] of reasons) if (code === id) validReason = true; // 匹配固定中文原因。
    if (!validReason) throw reviewError('INVALID_REVIEW', 400, '复核原因不在合成演示范围'); // 不将敏感输入带入文件。
  } // 结束原因校验。
  return { draftId: input.draftId, expectedRevision: input.expectedRevision, operationId: input.operationId, opinion: input.opinion, reasonCodes: [...input.reasonCodes].sort(), acknowledgement: true }; // 不保存请求头、自由任务原文或客户端时间。
} // 结束意见输入验证。
/** 构建历史视图；入参为草稿、意见清单与验证链摘要；出参为可导出对象；不会修改原始草稿。 */
function historyView(draft, reviews, chain) { // 最新意见是投影，不覆盖任何旧记录。
  const latest = reviews.at(-1); // 按服务端事件顺序判断，不依赖客户端时间。
  return { draftId: draft.draftId, createdAt: draft.createdAt, resultHash: draft.resultHash, sourceHash: draft.sourceHash, simulation: draft.simulation, revision: reviews.length, reviewStatus: latest ? 'opinion-recorded' : 'pending', latestOpinion: latest?.opinion ?? null, result: draft.result, reviews, chain, writes: 0, externalSends: 0, approval: '未获人工批准', synthetic: true }; // 记录意见不改变规则结果与批准状态。
} // 结束历史视图构建。
/** 创建本地追加日志；入参为配置及可选根目录（测试用）；出参为保存和查询方法；创建时不读业务或日志文件。 */
export function createReviewStore(config, baseDirectory = dirname(CONFIG_PATH)) { // 与源数据 data 目录分开。
  const path = resolve(baseDirectory, config.review.journalPath), directory = dirname(path), lockPath = path + '.lock'; // 路径仅来自已验证配置。
  let tail = Promise.resolve(), observedHead = null; // 同实例串行执行，并记录本次运行已经见过的日志头。
  /** 吸收队列错误；入参为已向调用方返回的异常；出参无；不吞掉原调用者收到的失败。 */
  function releaseQueue(error) { return undefined; } // 后续请求仍可检查或重试。
  /** 串行调度操作；入参为异步操作；出参为其 Promise；失败原样返回调用方。 */
  function enqueue(action) { // 不允许两个操作竞争同一版本。
    const pending = tail.then(action); tail = pending.catch(releaseQueue); return pending; // 队列不保存请求原文。
  } // 结束串行调度。
  /** 重放并验证日志；入参为完整文本；出参为草稿映射和链摘要；破损或关联异常时抛出 503。 */
  function replay(text) { // 每次读写前都重新验证，不信任缓存投影。
    const drafts = new Map(), reviews = new Map(), operations = new Map(), ids = new Set(); // 仅在当前操作内建立投影。
    let head = genesis, count = 0; // 从固定起点依次校验。
    if (!text && observedHead && observedHead !== genesis) throw reviewError('AUDIT_CORRUPT', 503, '已读取的复核日志丢失，请人工检查'); // 同运行内不能把文件丢失当作首次使用。
    if (text && !text.endsWith('\n')) throw reviewError('AUDIT_CORRUPT', 503, '复核日志存在不完整尾行，请人工检查'); // 不自动截断或掩盖半写记录。
    for (const line of text ? text.slice(0, -1).split('\n') : []) { // 不允许中间空行冒充合法事件。
      const entry = JSON.parse(line); // 解析失败由事务统一转换为日志故障。
      if (!exactKeys(entry, ['seq', 'previousHash', 'type', 'createdAt', 'data', 'hash'])) throw new Error('日志结构异常'); // 固定事件外壳。
      const { hash, ...body } = entry; // 保留写入时字段顺序计算同一摘要。
      if (entry.seq !== count + 1 || entry.previousHash !== head || hash !== digest(body) || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('日志链异常'); // 检测已见事件的改写、插入与乱序。
      const data = entry.data; // 此处只处理已校验外壳。
      if (entry.type === 'draft-created') { // 草稿事件仅由实际核对生成。
        if (!exactKeys(data, ['draftId', 'result', 'resultHash', 'sourceHash', 'simulation']) || !uuid.test(data.draftId) || ids.has(data.draftId)) throw new Error('草稿结构异常'); // 编号不能复用。
        if (!isObject(data.result) || !['review', 'manual', 'needs-info'].includes(data.result.status) || data.result.projectId !== config.project.projectId || data.result.recordId !== config.access.recordId || data.result.writes !== 0 || data.result.externalSends !== 0 || data.result.approval !== '未获人工批准') throw new Error('草稿边界异常'); // 审计不能变成业务批准。
        if (data.result.sources?.length !== 1 || digest(data.result) !== data.resultHash || digest(data.result.sources[0].snapshot) !== data.sourceHash) throw new Error('草稿指纹异常'); // 来源与规则结论都固定绑定。
        getDemoProduct(config, data.result.sources[0].snapshot); // 防止读取非合成来源作为正常历史。
        drafts.set(data.draftId, { ...data, createdAt: entry.createdAt }); reviews.set(data.draftId, []); ids.add(data.draftId); // 建立历史投影。
      } else if (entry.type === 'opinion-recorded') { // 只允许追加意见事件。
        if (!exactKeys(data, ['reviewId', 'draftId', 'revision', 'previousReviewId', 'operationId', 'reviewer', 'opinion', 'reasonCodes', 'acknowledgement']) || !uuid.test(data.reviewId) || ids.has(data.reviewId) || !drafts.has(data.draftId) || data.reviewer !== config.access.identity) throw new Error('意见结构异常'); // 不接受孤立意见或伪造角色。
        const history = reviews.get(data.draftId); // 获取该草稿的既有意见。
        if (data.revision !== history.length + 1 || data.previousReviewId !== (history.at(-1)?.reviewId ?? null) || operations.has(data.operationId)) throw new Error('意见关联异常'); // 防止版本跳跃或重复操作落盘。
        validateReview(config, { identity: data.reviewer, draftId: data.draftId, expectedRevision: data.revision - 1, operationId: data.operationId, opinion: data.opinion, reasonCodes: data.reasonCodes, acknowledgement: data.acknowledgement }); // 意见内容仍须符合当前固定契约。
        const review = { ...data, createdAt: entry.createdAt }; history.push(review); operations.set(data.operationId, review); ids.add(data.reviewId); // 旧意见不被覆盖。
      } else { throw new Error('未知事件'); } // 禁止通过日志扩展为审批事件。
      head = hash; count += 1; // 前进到已校验事件。
      if (count > config.review.maxEvents) throw reviewError('AUDIT_LIMIT', 503, '复核日志超过事件上限，请人工归档'); // 不悄悄丢掉旧事件。
    } // 结束逐事件验证。
    if (observedHead && observedHead !== genesis && head !== observedHead) { // 本运行已见过的链头必须仍在链中。
      let found = false; // 整体删除或尾部回退不能被当作空日志。
      for (const line of text.slice(0, -1).split('\n')) if (JSON.parse(line).hash === observedHead) found = true; // 允许合法的新事件延长链。
      if (!found) throw reviewError('AUDIT_CORRUPT', 503, '已读取的复核记录丢失或回退，请人工检查'); // 不自动建立新起点。
    } // 结束本次运行回退检测。
    observedHead = head; // 保存当前运行的本地检查点。
    return { drafts, reviews, operations, head, count, bytes: Buffer.byteLength(text) }; // 返回经过验证的状态。
  } // 结束重放。
  /** 持锁读日志；入参无；出参为验证投影；缺失日志首次视为空，其他故障拒绝继续。 */
  async function readLedger() { // 不读取原始业务快照。
    let file; // 无论读成功与否都关闭句柄。
    try { // 使用不可跟随链接的文件描述符。
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); // 防止文件链接指向其他资料。
      const metadata = await file.stat(); // 先限制读取大小。
      if (!metadata.isFile() || metadata.size > config.review.maxJournalBytes) throw reviewError('AUDIT_LIMIT', 503, '复核日志超过容量或不是普通文件'); // 不无界载入日志。
      return replay(await file.readFile('utf8')); // 严格检查完整哈希链。
    } catch (error) { // 缺文件仅在没有既有检查点时允许。
      if (error.code === 'ENOENT') return replay(''); // 已见过的非空日志丢失仍会被 replay 拒绝。
      if (error.code === 'AUDIT_LIMIT' || error.code === 'AUDIT_CORRUPT') throw error; // 保留固定公开错误。
      throw reviewError('AUDIT_CORRUPT', 503, '复核日志无法完整验证，请人工检查'); // 不返回日志原文。
    } finally { if (file) await file.close(); } // 释放读取句柄。
  } // 结束持锁读取。
  /** 执行文件事务；入参为读取投影后的操作；出参为该操作结果；冲突和文件失败均不报告成功。 */
  async function transaction(action) { // 跨服务实例也用排他锁，避免同时追加。
    let lock; // 仅释放本操作成功取得的锁。
    try { // 锁不在应用启动时创建，未授权请求不能触发此函数。
      await mkdir(directory, { recursive: true, mode: 0o700 }); // 本地运行文件夹不入库。
      if (await realpath(directory) !== resolve(await realpath(baseDirectory), dirname(config.review.journalPath))) throw reviewError('AUDIT_UNAVAILABLE', 503, '复核目录不可使用符号链接'); // 避免审计路径越界。
      lock = await open(lockPath, 'wx', 0o600); // 多进程抢锁时失败，不偷走现有锁。
      const ledger = await readLedger(); // 读写前始终检查完整链。
      return await action(ledger); // 操作期间持有排他锁。
    } catch (error) { // 不把文件系统异常原文返回用户。
      if (error.status && error.code) throw error; // 传播已受控的冲突或业务错误。
      if (error.code === 'EEXIST') throw reviewError('AUDIT_BUSY', 503, '复核日志正在使用或存在遗留锁，请稍后重试并人工检查'); // 崩溃锁不能自动删除。
      throw reviewError('AUDIT_UNAVAILABLE', 503, '复核日志读写失败，未确认保存成功'); // 不伪造保存成功。
    } finally { if (lock) { await lock.close(); await unlink(lockPath); } } // 只移除自己持有的短时锁。
  } // 结束文件事务。
  /** 追加并同步事件；入参为验证投影、事件类型和脱敏数据；出参为新事件；写盘失败抛出错误且不覆盖原文件。 */
  async function append(ledger, type, data) { // 永远使用追加模式，不提供更新和删除接口。
    const body = { seq: ledger.count + 1, previousHash: ledger.head, type, createdAt: new Date().toISOString(), data }; // 时间和序号由服务端生成。
    const entry = { ...body, hash: digest(body) }, line = JSON.stringify(entry) + '\n'; // 一行一个可验证事件。
    if (ledger.count >= config.review.maxEvents || ledger.bytes + Buffer.byteLength(line) > config.review.maxJournalBytes) throw reviewError('AUDIT_LIMIT', 503, '复核日志已满，请人工归档后处理'); // 禁止自动轮转删除旧意见。
    const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600); // 文件不能跟随符号链接。
    try { await file.writeFile(line); await file.sync(); } finally { await file.close(); } // 同步完成后才允许向页面确认保存。
    observedHead = entry.hash; // 仅更新本进程已同步的链头。
    return entry; // 返回用于构建响应的事件。
  } // 结束事件追加。
  /** 保存合成草稿；入参为领域结果和核对输入；出参为草稿编号及初始版本；不符合范围或文件失败时拒绝。 */
  async function recordDraft(result, input = {}) { // 调用方只对有有效来源的可复核结果调用。
    /** 保存事务；入参为已验证日志；出参为持久草稿摘要；追加失败直接拒绝。 */
    async function save(ledger) { // 不接受客户端自行提交的草稿结果。
      if (!['review', 'manual', 'needs-info'].includes(result.status) || result.sources?.length !== 1) throw reviewError('INVALID_DRAFT', 400, '只有带来源的草稿可记录复核意见'); // 拒绝无来源和被拦截的任务。
      const simulation = {}; // 仅记录被规则验证过的合成覆盖值。
      for (const key of ['scenario', 'trainingVersion', 'trainingState', 'completedItems', 'receiver']) if (input[key] !== undefined) simulation[key] = structuredClone(input[key]); // 排除任务原文、请求头和身份自由文字。
      const data = { draftId: randomUUID(), result: structuredClone(result), resultHash: digest(result), sourceHash: digest(result.sources[0].snapshot), simulation }; // 草稿、结论和来源绑定。
      const entry = await append(ledger, 'draft-created', data); // 只追加原始草稿。
      return { draftId: data.draftId, draftCreatedAt: entry.createdAt, reviewRevision: 0, reviewStatus: 'pending', localAuditWrites: 1 }; // 本地审计写入与业务 writes=0 分开。
    } // 结束草稿保存事务。
    /** 调度草稿事务；入参无；出参为事务 Promise；错误传回请求方。 */
    function schedule() { return transaction(save); } // 串行化同一文件操作。
    return enqueue(schedule); // 返回实际落盘结果。
  } // 结束草稿记录。
  /** 查询复核历史；入参为草稿 UUID；出参为原始结果、完整意见和链摘要；不存在返回 404，日志故障拒绝查询。 */
  async function history(draftId) { // 历史读取不依赖当前原始来源可用性。
    /** 查询事务；入参为验证投影；出参为历史对象；未知草稿抛出 404。 */
    async function read(ledger) { // 先验证链再提供任何记录。
      if (!ledger.drafts.has(draftId)) throw reviewError('DRAFT_NOT_FOUND', 404, '草稿不存在或不在演示范围'); // 不拼接文件路径。
      return historyView(ledger.drafts.get(draftId), ledger.reviews.get(draftId), { verified: true, eventCount: ledger.count, headHash: ledger.head }); // 返回只读历史投影。
    } // 结束查询事务。
    /** 调度历史事务；入参无；出参为 Promise；失败传回请求方。 */
    function schedule() { return transaction(read); } // 防止读到追加中的半行。
    return enqueue(schedule); // 串行读取。
  } // 结束历史查询。
  /** 列出最近草稿；入参无；出参为限额内摘要及链头；日志故障时拒绝，不伪造空列表。 */
  async function list() { // 刷新或重启后从文件重建。
    /** 列表事务；入参为已验证投影；出参为摘要列表；不返回自由任务原文。 */
    async function read(ledger) { // 不读取原始业务快照。
      const drafts = []; // 仅返回最近配置数量。
      for (const draft of [...ledger.drafts.values()].reverse().slice(0, config.review.listLimit)) { // 按服务端事件顺序显示。
        const reviews = ledger.reviews.get(draft.draftId); // 当前草稿意见集合。
        drafts.push({ draftId: draft.draftId, createdAt: draft.createdAt, status: draft.result.status, revision: reviews.length, reviewStatus: reviews.length ? 'opinion-recorded' : 'pending', latestOpinion: reviews.at(-1)?.opinion ?? null, resultHash: draft.resultHash }); // 不把意见记录误显示为批准。
      } // 结束摘要生成。
      return { drafts, chain: { verified: true, eventCount: ledger.count, headHash: ledger.head }, writes: 0, externalSends: 0 }; // 链完整不代表数字签名或真实身份。
    } // 结束列表事务。
    /** 调度列表事务；入参无；出参为 Promise；失败传回请求方。 */
    function schedule() { return transaction(read); } // 与写入使用同一锁。
    return enqueue(schedule); // 返回经过验证的列表。
  } // 结束草稿列表。
  /** 追加人工意见；入参为规范命令和当前来源读取器；出参为意见、版本及幂等标识；冲突、来源变化或文件失败时拒绝。 */
  async function recordReview(command, readSnapshot) { // 只记录操作员实际提交的结构化意见。
    command = validateReview(config, { identity: config.access.identity, ...command }); // 存储入口再次卡住人工确认，防止内部调用绕过 HTTP 校验。
    /** 意见事务；入参为验证投影；出参为已落盘意见；失败不生成批准状态。 */
    async function save(ledger) { // 整个版本检查和追加处于同一锁内。
      const draft = ledger.drafts.get(command.draftId); // 从服务端日志定位草稿。
      if (!draft) throw reviewError('DRAFT_NOT_FOUND', 404, '草稿不存在或不在演示范围'); // 客户端不能伪造草稿结果。
      const previous = ledger.operations.get(command.operationId); // 先处理重试，再比较过期的期望版本。
      if (previous) { // 相同操作编号不得产生第二条意见。
        if (previous.draftId !== command.draftId || previous.opinion !== command.opinion || digest(previous.reasonCodes) !== digest(command.reasonCodes) || previous.revision !== command.expectedRevision + 1) throw reviewError('IDEMPOTENCY_CONFLICT', 409, '操作编号已用于其他意见，请刷新后重新提交'); // 不静默复用不同内容。
        return { review: previous, revision: previous.revision, replayed: true, localAuditWrites: 0, writes: 0, externalSends: 0, approval: '未获人工批准' }; // 幂等重放不再次写盘。
      } // 结束幂等检查。
      const history = ledger.reviews.get(command.draftId); // 获取该草稿当前版本。
      if (command.expectedRevision !== history.length) throw reviewError('REVISION_CONFLICT', 409, '已有新意见，请重新加载历史后再提交'); // 多页面竞争时不能覆盖别人已记录的意见。
      let current; // 当前来源只在授权且版本正确后读取。
      try { current = await readSnapshot(); getDemoProduct(config, current); } catch { throw reviewError('SOURCE_UNAVAILABLE', 503, '当前合成来源不可用，不能新增复核意见'); } // 不能以旧快照兜底确认。
      if (digest(current) !== draft.sourceHash || config.rules.version !== draft.result.ruleVersion) throw reviewError('DRAFT_STALE', 409, '来源或规则版本已变化，请重新运行核对生成新草稿'); // 旧草稿不能冒充当前状态。
      const data = { reviewId: randomUUID(), draftId: command.draftId, revision: history.length + 1, previousReviewId: history.at(-1)?.reviewId ?? null, operationId: command.operationId, reviewer: config.access.identity, opinion: command.opinion, reasonCodes: command.reasonCodes, acknowledgement: true }; // 只保存演示身份和白名单意见。
      const entry = await append(ledger, 'opinion-recorded', data); // 不更新原始草稿、培训或异常状态。
      return { review: { ...data, createdAt: entry.createdAt }, revision: data.revision, replayed: false, localAuditWrites: 1, writes: 0, externalSends: 0, approval: '未获人工批准' }; // 记录成功不是批准。
    } // 结束意见事务。
    /** 调度意见事务；入参无；出参为 Promise；冲突或文件失败传回请求方。 */
    function schedule() { return transaction(save); } // 同实例串行、跨实例锁互斥。
    return enqueue(schedule); // 返回真实持久结果。
  } // 结束人工意见追加。
  return { recordDraft, history, list, recordReview }; // 不暴露修改、删除、审批或放行方法。
} // 结束本地审计存储创建。
