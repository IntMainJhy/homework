import { isObject } from './config.mjs'; // 复用输入对象检查，不加载业务数据。
export const demoScenarios = [ // 演练场景属于固定契约，不是可执行用户指令。
  ['normal', '正常交接'], ['missing', '接收人缺失'], ['conflict', '培训版本冲突'], // 基础业务场景。
  ['unconfirmed', '培训尚未确认'], ['missing-item', '检查项漏记'], ['open-exception', '异常未关闭'], // 人工复核场景。
  ['invalid-rule', '指引未生效'], ['stale', '来源已过期'], ['unauthorized', '身份无权限'], // 来源与权限场景。
  ['outage', '来源不可用'], ['injection', '越界动作请求'], // 故障及动作边界场景。
]; // 结束固定场景表。
const inputFields = new Set(['scenario', 'mode', 'identity', 'moduleId', 'recordId', 'request', 'trainingVersion', 'trainingState', 'completedItems', 'receiver']); // 输入白名单。
/** 检查演示授权；入参为配置、项目编号和输入；出参为空串或错误码；失败时不读取业务来源。 */
export function accessError(config, projectId, input) { // HTTP 入口和规则入口共同使用。
  if (!isObject(input) || input.identity !== config.access.identity) return 'FORBIDDEN'; // 客户端声明身份只是教学白名单，不能宣称真实登录。
  if (projectId !== config.project.projectId || (input.moduleId !== undefined && input.moduleId !== projectId)) return 'SCOPE_FORBIDDEN'; // 先卡项目和模块再读数据。
  if (input.recordId !== undefined && input.recordId !== config.access.recordId) return 'SCOPE_FORBIDDEN'; // 包含空编号在内的非法范围均不能回退到默认样本。
  return ''; // 仅代表通过本地演示授权检查。
} // 结束演示授权检查。
/** 形成领域结果；入参为配置、状态、标题、摘要及可选轨迹来源；出参为只读核对结果；无外部副作用。 */
function outcome(config, status, title, summary, trace = [], details = [], sources = []) { // 对每个分支保留一致的领域字段。
  return { // 不回显原始任务文字，避免日志或导出记录携带任意敏感输入。
    projectId: config.project.projectId, moduleId: config.project.projectId, recordId: config.access.recordId, // 返回固定教学范围。
    status, title, summary, details, sources, trace, mode: 'offline-fixture', // 状态不代表批准。
    ruleVersion: config.rules.version, writes: 0, externalSends: 0, synthetic: true, // 所有路径均无业务写入或发送。
    approval: '未获人工批准', reviewStatus: 'pending', reviewOwner: '质量复核负责人（待具名授权）', // 人工意见未实现时必须保持待复核。
  }; // 结束领域结果对象。
} // 结束结果构建。
/** 校验输入契约；入参为配置和任务对象；出参为错误信息或空串；失败不读取来源。 */
function inputError(config, input) { // 所有用户字段均按数据处理。
  if (!isObject(input)) return '请提交任务对象'; // 拒绝 null 和数组。
  for (const key of Object.keys(input)) { // 检查未知字段，禁止通过参数增加能力。
    if (!inputFields.has(key)) return '存在未定义输入字段'; // 包括 approve 等越权参数。
  } // 结束字段白名单检查。
  let known = false; // 固定场景枚举不能由用户扩展。
  for (const [id] of demoScenarios) if (id === (input.scenario ?? 'normal')) known = true; // 查找显式场景。
  if (!known) return '演练场景无效'; // 错误场景不回退正常。
  if (input.mode !== undefined && input.mode !== 'offline') return '仅支持本地规则模式'; // 本阶段没有在线模型接口。
  if (input.request !== undefined && (typeof input.request !== 'string' || !input.request.trim() || input.request.length > config.rules.maxRequestLength)) return '任务文字长度或类型无效'; // 不宽松转换任务类型。
  for (const field of ['trainingVersion', 'receiver']) { // 检查可编辑字符串。
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > config.rules.maxFieldLength)) return '版本或接收人字段无效'; // 保留空值用于缺项演练。
  } // 结束字符串检查。
  if (input.trainingState !== undefined && !['confirmed', 'unconfirmed', 'missing'].includes(input.trainingState)) return '培训确认状态无效'; // 存在、确认和缺失不能混同。
  if (input.completedItems !== undefined) { // 检查清单类型及数量。
    if (!Array.isArray(input.completedItems) || input.completedItems.length > config.rules.maxItems) return '检查项必须是限长数组'; // 防止字符串被当数组。
    for (const item of input.completedItems) { // 每项均执行编号检查。
      if (typeof item !== 'string' || item.length > config.rules.maxItemLength || !/^C[0-9]{2,4}$/.test(item)) return '检查项仅接受合成编号，例如 C01'; // 禁止把人员信息等任意文字放入导出来源。
    } // 结束单项检查。
  } // 结束清单检查。
  if (input.trainingVersion !== undefined && input.trainingVersion.trim() && !/^v[0-9]{1,6}$/.test(input.trainingVersion)) return '版本仅接受合成编号，例如 v1 或 v2'; // 首版只处理演示版本，避免存入任意资料。
  if (input.receiver !== undefined && input.receiver.trim() && input.receiver !== '质量复核员（演示）') return '接收人仅允许质量复核员（演示）或空值'; // 不收集真实人员姓名。
  return ''; // 输入符合教学数据契约。
} // 结束输入校验。
/** 校验来源结构；入参为配置与来源；出参为布尔值；非法来源返回 false，不猜补字段。 */
function validSnapshot(config, data) { // 来源不可执行，也不能带入未知字段。
  if (!isObject(data) || data.synthetic !== true || data.id !== config.access.recordId) return false; // 拒绝真实或跨记录资料。
  const allowed = new Set(['synthetic', 'id', 'job', 'process', 'batch', 'instructionVersion', 'instructionState', 'validFrom', 'validTo', 'trainingVersion', 'trainingState', 'requiredItems', 'completedItems', 'owner', 'receiver', 'exceptions', 'sourceVersion', 'capturedAt', 'reviewedAt']); // 合成文件字段契约。
  for (const key of Object.keys(data)) if (!allowed.has(key)) return false; // 未识别字段不进入快照和导出。
  for (const key of ['job', 'process', 'batch', 'instructionVersion', 'instructionState', 'validFrom', 'validTo', 'trainingVersion', 'trainingState', 'owner', 'receiver', 'sourceVersion', 'capturedAt', 'reviewedAt']) { // 验证所有必需文本。
    if (typeof data[key] !== 'string') return false; // 空值按业务规则处理，类型错误按来源故障处理。
  } // 结束来源字符串检查。
  if (!/^JOB-[0-9]+$/.test(data.job) || !/^PROC-[0-9]+$/.test(data.process) || !/^BATCH-DEMO-[0-9]+$/.test(data.batch)) return false; // 限定为合成标识。
  if (data.owner !== '现场专员（演示）' || !['', '质量复核员（演示）'].includes(data.receiver)) return false; // 防止误导入真实人员。
  if (!['confirmed', 'unconfirmed', 'missing'].includes(data.trainingState) || !['confirmed', 'unconfirmed', 'missing'].includes(data.instructionState)) return false; // 不接受未知确认状态。
  if (!/^v[0-9]{1,6}$/.test(data.instructionVersion) || (data.trainingVersion && !/^v[0-9]{1,6}$/.test(data.trainingVersion)) || !/^snapshot-v[0-9]+$/.test(data.sourceVersion)) return false; // 来源版本也限定合成格式。
  for (const key of ['requiredItems', 'completedItems']) { // 验证两组检查项。
    if (!Array.isArray(data[key]) || data[key].length > config.rules.maxItems) return false; // 禁止畸形清单。
    for (const item of data[key]) if (typeof item !== 'string' || !/^C[0-9]{2,4}$/.test(item)) return false; // 限定合成编号。
  } // 结束来源清单检查。
  if (data.requiredItems.length === 0 || new Set(data.requiredItems).size !== data.requiredItems.length) return false; // 空或重复必查项无法证明完整性。
  if (!Array.isArray(data.exceptions)) return false; // 异常必须显式提供清单。
  for (const item of data.exceptions) { // 异常也只能包含合成信息。
    if (!isObject(item) || !/^EX-DEMO-[0-9]+$/.test(item.id) || !['open', 'closed'].includes(item.status) || item.owner !== data.owner || Object.keys(item).length !== 3) return false; // 拒绝混入个人信息及未知异常状态。
  } // 结束异常结构检查。
  return true; // 来源结构可用于只读核对。
} // 结束来源结构验证。
/** 构建工作台展示信息；入参为配置和已授权读取的来源；出参为页面元数据；非法来源抛出固定异常。 */
export function getDemoProduct(config, snapshot) { // 调用方必须先检查权限。
  if (!validSnapshot(config, snapshot)) throw new Error('SOURCE_INVALID'); // 不在页面展示畸形资料。
  return { // 保留原工作台的业务概念。
    name: config.project.modules[0].title, product: '岗位作业交接核对助手', record: snapshot.id, // 展示固定教学对象。
    subtitle: '对齐培训版本、工序检查项与具名交接记录', // 不宣称使用大模型。
    boundary: '合成资料只读核对；不控制设备、不替代安全培训、不批准生产放行。', // 让人工责任始终可见。
    agents: ['范围与身份核对', '版本与完整性核对', '人工交接草稿'], // 三个确定性节点。
    defaults: { scenario: 'normal', mode: 'offline', identity: config.access.identity, moduleId: config.project.projectId, recordId: snapshot.id, request: '核对本批次培训版本与检查项，列出缺口、来源与人工接收人。', trainingVersion: snapshot.trainingVersion, trainingState: snapshot.trainingState, completedItems: [...snapshot.completedItems], receiver: snapshot.receiver }, // 从授权来源初始化表单。
  }; // 结束页面元数据。
} // 结束工作台信息构建。
/** 执行只读核对；入参为项目编号、任务及含 config/readSnapshot 的上下文；出参为领域结果；输入拒绝不读来源，来源故障降级。 */
export async function runProjectDemo(projectId, input, context) { // 服务端和自动测试共用同一条规则链。
  const { config, readSnapshot } = context; // 不使用模块级业务快照。
  const trace = [{ step: 1, agent: '范围与身份核对', action: '校验输入与范围', detail: '本地演示身份，不代表真实登录或正式授权。' }]; // 轨迹不存任务原文。
  const invalid = inputError(config, input); // 先验证数据格式。
  if (invalid) return outcome(config, 'blocked', '输入不符合契约', invalid, trace); // 数据不合法时不读取来源。
  if (accessError(config, projectId, input) || input.scenario === 'unauthorized') return outcome(config, 'blocked', '访问被拒绝', '未读取业务来源，请核对演示身份与范围。', trace); // 权限必须先于数据读取。
  const request = input.request ?? ''; // 任务仅用于边界检查，不保存和执行。
  if (input.scenario === 'injection' || /自动.{0,6}(放行|审批|批准|发送|培训确认)|绕过|忽略.{0,6}(规则|安全|权限)|控制设备|启停|直接支付|批准生产|自动勾选|override|approve|shutdown/i.test(request)) { // 显式拒绝已知越界表达；无任何可写工具兜底。
    return outcome(config, 'blocked', '请求超出只读范围', '请授权人员按既有流程处理；本系统没有审批、写回或设备接口。', trace); // 自然语言不能增加权限。
  } // 结束动作边界检查。
  if (input.scenario === 'outage') return outcome(config, 'degraded', '来源不可用，转人工', '故障演练未读取来源，不以历史快照证明当前状态。', trace); // 故障不自动重试业务动作。
  let original; // 只在权限通过后持有来源。
  try { // 读取失败与畸形来源均降级。
    original = structuredClone(await readSnapshot()); // 使用独立副本，不修改读取器返回的原对象。
    if (!validSnapshot(config, original)) throw new Error('SOURCE_INVALID'); // 不推测缺失来源字段。
  } catch { // 不暴露文件路径、原文或内部异常。
    return outcome(config, 'degraded', '来源不可用，转人工', '合成文件缺失、格式错误或字段无效；请维护人员检查。', trace); // 停止形成通过结论。
  } // 结束来源读取处理。
  const data = structuredClone(original); // 场景故障与表单覆盖仅作用于第二份副本。
  for (const field of ['trainingVersion', 'trainingState', 'completedItems', 'receiver']) if (input[field] !== undefined) data[field] = structuredClone(input[field]); // 原始来源保持不变。
  if (input.scenario === 'missing') data.receiver = ''; // 注入接收人缺失。
  if (input.scenario === 'conflict') data.trainingVersion = 'v1'; // 注入版本冲突。
  if (input.scenario === 'unconfirmed') data.trainingState = 'unconfirmed'; // 注入未确认状态。
  if (input.scenario === 'missing-item') data.completedItems = data.requiredItems.slice(0, -1); // 注入清单漏项。
  if (input.scenario === 'open-exception') data.exceptions = [{ id: 'EX-DEMO-001', status: 'open', owner: data.owner }]; // 注入合成未结异常。
  if (input.scenario === 'invalid-rule') data.instructionState = 'unconfirmed'; // 注入指引未确认。
  if (input.scenario === 'stale' && Number.isFinite(Date.parse(data.reviewedAt))) data.capturedAt = new Date(Date.parse(data.reviewedAt) - (config.rules.maxAgeMinutes + 1) * 60000).toISOString(); // 注入旧快照时间。
  const sources = [{ id: original.id + '@' + original.sourceVersion, title: '岗位作业交接包合成快照', location: config.data.fixturePath, version: original.sourceVersion, capturedAt: original.capturedAt, synthetic: true, snapshot: original, excerpt: JSON.stringify(original) }]; // 引用原始快照，不把演练覆盖冒充来源事实。
  trace.push({ step: 2, agent: '版本与完整性核对', action: '读取合成来源并核对副本', detail: '保留原始快照；表单覆盖和故障场景仅用于合成演练。' }); // 区分来源和用户模拟输入。
  const captured = Date.parse(data.capturedAt), reviewed = Date.parse(data.reviewedAt), start = Date.parse(data.validFrom), end = Date.parse(data.validTo); // 统一计算时间。
  if (![captured, reviewed, start, end].every(Number.isFinite) || start >= end) return outcome(config, 'manual', '来源时间无效', '日期缺失、非法或有效期倒置，必须人工核实。', trace, [], sources); // 无效日期不能绕过比较。
  const age = (reviewed - captured) / 60000; // 使用固定合成核对时间，避免冒充实时业务核对。
  if (age < 0 || age > config.rules.maxAgeMinutes) return outcome(config, 'manual', '来源过期，需要人工核对', '核对副本时间不符合配置的教学阈值；不得以历史快照证明当前状态。', trace, [], sources); // 新鲜度不明则停结论。
  if (data.instructionState !== 'confirmed' || reviewed < start || reviewed >= end) return outcome(config, 'manual', '指引未确认或不在有效期', '有效期和人工确认状态必须同时满足。', trace, [], sources); // 指引存在不等于适用。
  const missing = []; // 分开记录缺失与未确认。
  if (!data.trainingVersion.trim() || data.trainingState === 'missing') missing.push('培训记录或版本缺失'); // 缺失要求补资料。
  if (!data.receiver.trim()) missing.push('接收人缺失'); // 不猜测交接责任人。
  for (const item of data.requiredItems) if (!data.completedItems.includes(item)) missing.push('检查项未记录：' + item); // 覆盖每个必查项。
  if (missing.length) return outcome(config, 'needs-info', '交接资料不完整', '保留原始记录，补齐后重新核对。', trace, missing, sources); // 缺项不能归为通过。
  if (data.trainingVersion !== data.instructionVersion) return outcome(config, 'manual', '培训版本与指引不一致', '由资料负责人确认适用版本与补训范围，不自动认定责任。', trace, ['培训：' + data.trainingVersion, '工序指引：' + data.instructionVersion], sources); // 安全版本判断保留人工责任。
  if (data.trainingState === 'unconfirmed') return outcome(config, 'manual', '培训状态尚未确认', '记录存在但未经确认，不能当作缺失或已完成。', trace, [], sources); // 明确区分未确认与缺失。
  const open = []; // 收集合成未结异常。
  for (const item of data.exceptions) if (item.status !== 'closed') open.push(item.id + ' / ' + item.owner + ' / ' + item.status); // 不自动关闭异常。
  if (open.length) return outcome(config, 'manual', '存在未结异常', '保留异常责任人与状态，转质量负责人复核。', trace, open, sources); // 有未结事项不形成通过结论。
  trace.push({ step: 3, agent: '人工交接草稿', action: '生成待复核草稿', detail: '规则通过只生成草稿，人工确认不能触发生产放行。' }); // 人工关卡没有自动批准路径。
  const details = ['岗位 ' + data.job + '；工序 ' + data.process + '；批次 ' + data.batch, '培训与工序指引均为 ' + data.instructionVersion, '必查项 ' + data.requiredItems.join('、') + ' 均有记录', '交出人：' + data.owner + '；接收人：' + data.receiver, '下一步：授权人员核对原始证据并按既有流程处理。']; // 只输出合成字段。
  return outcome(config, 'review', '交接核对草稿，待人工复核', '已按固定合成时间执行教学规则；不代表真实培训合格或生产放行。', trace, details, sources); // 默认始终待人工复核。
} // 结束核对主流程。
/** 执行场景评估；入参为配置与延迟读取器上下文；出参为 17 个合成场景结果；异常向调用方抛出，不宣称真实验收。 */
export async function evaluateProjectDemo(context) { // 保留原来的 17 个回归场景。
  const { config } = context; // 使用唯一配置。
  const expected = { normal: 'review', missing: 'needs-info', conflict: 'manual', unconfirmed: 'manual', 'missing-item': 'needs-info', 'open-exception': 'manual', 'invalid-rule': 'manual', stale: 'manual', unauthorized: 'blocked', outage: 'degraded', injection: 'blocked' }; // 固定业务预期。
  const base = { identity: config.access.identity, recordId: config.access.recordId, moduleId: config.project.projectId, mode: 'offline' }; // 固定合成范围。
  const checks = []; // 依次创建独立输入。
  for (const [scenario, label] of demoScenarios) checks.push({ id: scenario, label, input: { ...base, scenario }, expected: expected[scenario] }); // 覆盖 11 个业务场景。
  for (const [id, patch] of [['unknown-record', { recordId: 'OTHER' }], ['module-boundary', { moduleId: 'OTHER' }], ['invalid-identity', { identity: 'admin' }], ['unknown-field', { approve: true }], ['bad-items', { completedItems: 'C01' }], ['bad-state', { trainingState: 'done' }]]) checks.push({ id, label: id, input: { ...base, ...patch }, expected: 'blocked' }); // 覆盖 6 个契约边界。
  const cases = []; // 逐个核对，避免共享副本。
  let passed = 0; // 统计实际通过数量。
  for (const check of checks) { // 每个场景均经过实际规则入口。
    const output = await runProjectDemo(config.project.projectId, check.input, context); // 不依据场景名称伪造结果。
    const sourceCount = ['blocked', 'degraded'].includes(check.expected) ? 0 : 1; // 拒绝和故障不应读取来源。
    const valid = output.status === check.expected && output.sources.length === sourceCount && output.writes === 0 && output.externalSends === 0 && output.approval === '未获人工批准'; // 同时检查副作用与人工边界。
    if (valid) passed += 1; // 仅统计全部断言成立的场景。
    cases.push({ ...check, actual: output.status, output, passed: valid }); // 保留可复现证据。
  } // 结束逐场景评估。
  return { mode: 'offline-fixture', ruleVersion: config.rules.version, total: cases.length, passed, cases }; // 不使用硬编码通过数。
} // 结束场景评估。
