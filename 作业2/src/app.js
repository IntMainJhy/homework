let state, input, result = null, lastError = '', tab = 'workspace', evaluation = null, busy = false, runs = 0; // 页面只保留当前会话，不持久化资料。
const statusNames = { review: '待人工复核', 'needs-info': '待补资料', manual: '转人工核对', blocked: '已拒绝', degraded: '降级转人工' }; // 固定业务状态名称。
/** 转义单字符；入参为匹配字符；出参为 HTML 实体；未匹配字符不会调用本函数。 */
function escapeCharacter(character) { // 所有动态文字都作为文本显示。
  return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]; // 防止输入成为 HTML。
} // 结束字符转义。
/** 转义文本；入参为任意展示值；出参为安全字符串；空值显示为空串。 */
function esc(value) { // 页面不直接插入未转义业务值。
  return String(value ?? '').replace(/[&<>"']/g, escapeCharacter); // 使用固定实体表。
} // 结束文本转义。
/** 调用同源 API；入参为路径、可选请求体和演示身份；出参为 data；失败抛出固定格式错误，不记录请求原文。 */
async function api(path, payload, identity = input?.identity ?? 'operator') { // 仅请求本地同源路径。
  const headers = { 'X-Demo-Identity': identity }; // 此身份可自报，仅供合成演示，不宣称真实鉴权。
  const options = { headers, cache: 'no-store' }; // 不缓存业务来源。
  if (payload !== undefined) { options.method = 'POST'; headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(payload); } // 业务执行用 JSON POST。
  const response = await fetch(path, options); // 不调用外部服务。
  const envelope = await response.json(); // 业务接口统一返回 JSON。
  if (!response.ok || envelope.ok !== true) throw new Error(envelope.error?.msg || '本地接口暂不可用'); // 不把失败当成空结果。
  return envelope.data; // 业务状态由 data.status 单独判断。
} // 结束 API 调用。
/** 生成选项；入参为编号标题对及选中编号；出参为 HTML 字符串；缺省清单返回空串。 */
function options(items, selected) { // 复用场景及身份选项。
  let html = ''; // 从空字符串开始。
  for (const [id, title] of items) html += `<option value="${esc(id)}" ${selected === id ? 'selected' : ''}>${esc(title)}</option>`; // 标题和属性值均转义。
  return html; // 返回安全选项。
} // 结束选项构建。
/** 构建任务表单；入参无；出参为 HTML；配置未加载时不会调用。 */
function formView() { // 保留原工作台字段。
  return '<section class="demo-panel demo-input"><div class="demo-panel-title"><h2>提交核对任务</h2><span>合成资料</span></div><form id="demo-form">' + // 表单入口。
    '<label>执行方式<select id="demo-mode" disabled><option>本地确定性规则（无模型）</option></select></label>' + // 不保留未实现的在线入口。
    `<label>演练场景<select id="demo-scenario">${options(state.scenarios, input.scenario)}</select></label>` + // 固定场景。
    `<label>演示身份<select id="demo-identity">${options([['operator', 'operator · 合成样本经办人'], ['unknown', '未授权访客']], input.identity)}</select></label>` + // 明确身份只用于演示。
    `<label>模块<input id="demo-module" value="${esc(input.moduleId)}" readonly></label>` + // 不扩大模块。
    `<label>交接包编号<input id="demo-record" value="${esc(input.recordId)}" maxlength="${state.limits.field}"></label>` + // 编号仍由服务端检查。
    `<label>培训材料版本（v1、v2 或空值）<input id="handover-training" value="${esc(input.trainingVersion)}" maxlength="${state.limits.field}"></label>` + // 仅合成版本。
    `<label>培训确认状态<select id="handover-state">${options([['confirmed', '已确认（合成）'], ['unconfirmed', '尚未确认'], ['missing', '记录缺失']], input.trainingState)}</select></label>` + // 三种状态分别展示。
    `<label>已记录检查项（如 C01,C02）<input id="handover-items" value="${esc(input.completedItems.join(','))}" maxlength="200"></label>` + // 输入会在服务端验证。
    `<label>接收人（仅演示名称或空值）<input id="handover-receiver" value="${esc(input.receiver)}" maxlength="${state.limits.field}"></label>` + // 不采集真实姓名。
    `<label>核对任务（请勿填写个人信息或密钥）<textarea id="demo-request" rows="4" maxlength="${state.limits.request}">${esc(input.request)}</textarea></label>` + // 自由文字不进入历史与导出。
    `<button class="demo-run" type="submit" ${busy ? 'disabled' : ''}>${busy ? '正在核对…' : '运行核对 →'}</button>` + // 阻止重复提交。
    '<p class="demo-input-note">身份选择不代表真实登录。只接受合成字段；正常结果仍需授权人员复核。</p></form></section>'; // 展示实际边界。
} // 结束表单构建。
/** 构建结果区；入参无；出参为 HTML；尚未运行或接口失败时不显示旧来源。 */
function resultView() { // 不用默认预览冒充已执行结果。
  if (!result) return `<section class="demo-panel demo-output" aria-live="polite"><h2>${lastError ? '请求已拒绝或服务不可用' : '尚未运行核对'}</h2><p>${esc(lastError || '提交任务后显示本次结果、来源及人工复核状态。')}</p><div class="demo-human"><b>人工复核关卡</b><p>尚未记录人工复核意见；本阶段没有审批或生产放行接口。</p></div></section>`; // 失败清除旧结果。
  let findings = ''; // 汇总纯合成差异。
  for (const detail of result.details) findings += `<li>${esc(detail)}</li>`; // 动态文字必须转义。
  return '<section class="demo-panel demo-output" aria-live="polite"><div class="demo-panel-title"><h2>核对结果</h2>' + // 保留原结果布局。
    `<span class="result-pill ${esc(result.status)}">${esc(statusNames[result.status])}</span></div><h3>${esc(result.title)}</h3><p class="result-summary">${esc(result.summary)}</p>` + // 状态来自领域结果。
    `<ol class="demo-findings">${findings}</ol><p class="demo-execution-note">规则版本：${esc(result.ruleVersion)}；仅执行本地规则，没有模型调用。</p>` + // 不暗示多模型协作。
    `<div class="demo-human"><b>人工复核关卡 · 待人工复核</b><p>${esc(result.approval)}。人工复核也不能触发业务写回或生产放行。</p></div>` + // 卡住人工批准边界。
    `<div class="demo-source-line">本次来源 ${result.sources.length} 份 · 业务写入 ${result.writes} · 外部发送 ${result.externalSends}</div>` + // 按实际结果展示。
    '<div class="demo-output-foot"><button id="download-result">导出本次核对记录</button><button data-demo-tab="audit">查看执行轨迹</button><button data-demo-tab="evidence">查看来源快照</button></div></section>'; // 仅本地导出。
} // 结束结果区构建。
/** 构建证据区；入参无；出参为 HTML；没有本次授权来源时只显示空状态。 */
function evidenceView() { // 不显示被拒请求之前的来源。
  let html = '<section class="demo-panel"><h2>本次来源快照</h2>'; // 使用当前结果。
  for (const source of result?.sources ?? []) html += `<article class="source-card"><h2>${esc(source.id)}</h2><p>位置：${esc(source.location)}；版本：${esc(source.version)}；采集：${esc(source.capturedAt)}</p><pre>${esc(JSON.stringify(source.snapshot, null, 2))}</pre></article>`; // 引用原始快照，不把演练覆盖当作事实。
  return html + '<p>来源为固定历史合成快照；场景与表单覆盖只作用于核对副本，不证明当前真实业务状态。</p></section>'; // 时间性质明确可见。
} // 结束证据区构建。
/** 构建执行轨迹；入参无；出参为 HTML；无结果时提示尚未执行。 */
function auditView() { // 轨迹仅在内存中显示。
  let html = '<section class="demo-panel"><h2>本次执行轨迹</h2><ol class="demo-timeline">'; // 沿用轨迹布局。
  for (const item of result?.trace ?? []) html += `<li><b>${item.step}</b><div><small>${esc(item.agent)}</small><h3>${esc(item.action)}</h3><p>${esc(item.detail)}</p></div></li>`; // 不包含任务原文。
  return html + `</ol><p>本会话完成 ${runs} 次接口核对；刷新即清空。导出只保留当前结果，不包含任务原文或访问令牌。</p><pre>${esc(result ? JSON.stringify({ ok: true, data: result, error: { code: '', msg: '' } }, null, 2) : '尚未运行')}</pre></section>`; // 展示统一接口结构。
} // 结束轨迹构建。
/** 构建评估区；入参无；出参为 HTML；未评估时不预填通过数。 */
function evaluationView() { // 不使用历史统计冒充本次结果。
  let rows = ''; // 按实际评估结果生成表格。
  for (const item of evaluation?.cases ?? []) rows += `<tr><td>${esc(item.label)}</td><td>${esc(item.expected)}</td><td>${esc(item.actual)}</td><td>${item.passed ? '通过' : '失败'}</td></tr>`; // 保留预期与实际对比。
  return `<section class="demo-panel"><div class="demo-panel-title"><h2>合成场景评估</h2><button id="demo-evaluate" ${busy ? 'disabled' : ''}>运行评估</button></div><p>按当前演示身份在服务端执行；不代表真实客户验收。</p>${evaluation ? `<div class="eval-summary">${evaluation.passed} / ${evaluation.total}</div><table><thead><tr><th>场景</th><th>预期</th><th>实际</th><th>结果</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>尚未运行评估。</p>'}</section>`; // 评估按钮不连接外部服务。
} // 结束评估区构建。
/** 读取表单；入参无；出参无；当前视图无表单时保持已有输入。 */
function readInput() { // 导航前保存当前编辑值。
  if (!document.getElementById('demo-form')) return; // 非工作台页没有表单。
  for (const [id, field] of [['demo-scenario', 'scenario'], ['demo-identity', 'identity'], ['demo-module', 'moduleId'], ['demo-record', 'recordId'], ['handover-training', 'trainingVersion'], ['handover-state', 'trainingState'], ['handover-receiver', 'receiver'], ['demo-request', 'request']]) input[field] = document.getElementById(id).value; // 白名单收集字段。
  input.completedItems = []; // 重新解析合成检查项。
  for (const value of document.getElementById('handover-items').value.split(/[,，]/)) if (value.trim()) input.completedItems.push(value.trim()); // 去除输入分隔空项。
} // 结束表单读取。
/** 渲染工作台；入参无；出参无；渲染异常交由启动或事件错误处理。 */
function render() { // 沿用原有侧栏、指标和面板样式。
  const product = state.product; // 使用授权状态接口返回的展示信息。
  let navigation = ''; // 四个原有工作区。
  for (const [id, name] of [['workspace', '业务工作台'], ['evidence', '证据与引用'], ['audit', '执行与审计'], ['evaluation', '场景评估']]) navigation += `<button data-demo-tab="${id}" class="${tab === id ? 'active' : ''}" ${busy ? 'disabled' : ''}>${name}</button>`; // 运行中不切换视图。
  const content = tab === 'workspace' ? `<section class="demo-agent-strip"><div><strong>01 范围与身份核对</strong></div><b>→</b><div><strong>02 版本与完整性核对</strong></div><b>→</b><div><strong>03 人工交接草稿</strong></div></section><div class="demo-workgrid">${formView()}${resultView()}</div>` : tab === 'evidence' ? evidenceView() : tab === 'audit' ? auditView() : evaluationView(); // 使用实际页面状态。
  document.title = product.product; // 设置中文页面标题。
  document.getElementById('demo-app').innerHTML = '<div class="demo-shell"><aside class="demo-sidebar"><div class="demo-brand"><b>交</b><div><strong>岗位作业交接核对助手</strong><small>FDE / RULE WORKSPACE</small></div></div>' + // 保留已有工作台框架。
    `<div class="demo-project">${esc(product.name)}<small>课堂合成工作空间</small></div><nav aria-label="工作区">${navigation}</nav><div class="demo-scope"><small>交付边界</small><p>${esc(product.boundary)}</p><span>只读核对 · 人工复核</span></div><div class="demo-offline">本地确定性规则<small>无模型调用 · 无业务写回</small></div></aside>` + // 不展示未实现能力。
    `<main><header class="demo-top"><span>生产岗位培训与工序交接</span><span>本机合成演示 · 阶段一</span></header><section class="demo-heading"><div><h1>${esc(product.product)}</h1><p>${esc(product.subtitle)}</p></div><span class="demo-version">${esc(state.ruleVersion)}</span></section>` + // 版本来自配置。
    `<div class="demo-metrics"><article><small>当前业务对象</small><strong>${esc(product.record)}</strong><span>合成样本</span></article><article><small>规则处理节点</small><strong>3</strong><span>确定性编排</span></article><article><small>当前处理状态</small><strong class="metric-status">${esc(result ? statusNames[result.status] : lastError ? '请求失败或被拒' : '尚未运行')}</strong><span>人工批准 0</span></article><article><small>教学时效阈值</small><strong>${state.maxAgeMinutes} 分钟</strong><span>使用固定合成核对时间</span></article></div>${content}` + // 不将历史样本当作实时状态。
    `<footer>${esc(state.assignment)} · 合成训练不代表真实客户授权或验收 · 刷新前请导出当前结果</footer></main></div><div id="demo-message" role="status">${esc(lastError)}</div>`; // 错误消息使用安全文本。
  for (const button of document.querySelectorAll('[data-demo-tab]')) button.addEventListener('click', changeTab); // 绑定具名导航函数。
  document.getElementById('demo-form')?.addEventListener('submit', runTask); // 只在工作台绑定。
  document.getElementById('demo-evaluate')?.addEventListener('click', runEvaluation); // 评估通过本地 API 执行。
  document.getElementById('download-result')?.addEventListener('click', downloadResult); // 本地下载不产生业务写回。
  if (busy) for (const element of document.querySelectorAll('input,select,textarea')) element.disabled = true; // 防止运行时改变输入造成结果混淆。
} // 结束页面渲染。
/** 切换工作区；入参为点击事件；出参无；运行中不切换。 */
function changeTab(event) { // 保留表单草稿。
  if (busy) return; // 防止并发界面操作。
  readInput(); tab = event.currentTarget.dataset.demoTab; render(); // 只改变内存视图。
} // 结束导航。
/** 执行核对；入参为提交事件；出参为异步完成；失败清空旧结果并展示中文信息。 */
async function runTask(event) { // 不直接运行浏览器规则。
  event.preventDefault(); // 阻止浏览器导航提交。
  if (busy) return; // 避免重复点击。
  readInput(); busy = true; lastError = ''; result = null; render(); // 清除旧来源以免误归属。
  try { result = await api('/api/run', { projectId: state.projectId, input }); runs += 1; } catch (error) { lastError = error.message; } finally { busy = false; render(); } // 所有结论都来自服务端。
} // 结束任务提交。
/** 执行场景评估；入参无；出参为异步完成；失败清空评估及旧业务来源。 */
async function runEvaluation() { // 未授权身份也会被服务端拒绝。
  if (busy) return; // 不并行重复评估。
  busy = true; lastError = ''; evaluation = null; render(); // 清除旧统计。
  try { evaluation = await api('/api/evaluate', { projectId: state.projectId, input: { identity: input.identity, moduleId: input.moduleId, recordId: input.recordId } }); } catch (error) { result = null; lastError = error.message; } finally { busy = false; render(); } // 不拿历史通过数兜底。
} // 结束评估提交。
/** 导出当前结果；入参无；出参无；没有结果时不操作，文件只含合成结果而不含任务原文。 */
function downloadResult() { // 导出不会触发正式确认。
  if (!result || busy) return; // 不导出失败后的旧记录。
  const blob = new Blob([JSON.stringify({ ok: true, data: result, error: { code: '', msg: '' } }, null, 2)], { type: 'application/json' }); // 保持统一结构。
  const url = URL.createObjectURL(blob); // 在本地内存生成文件地址。
  const anchor = document.createElement('a'); // 临时下载节点。
  anchor.href = url; anchor.download = '交接核对记录.json'; anchor.click(); // 仅向当前浏览器下载。
  /** 释放下载地址；入参无；出参无；不修改任何业务资料。 */
  function releaseDownload() { URL.revokeObjectURL(url); } // 释放临时内存。
  setTimeout(releaseDownload, 1000); // 给下载开始留出时间。
} // 结束本地导出。
try { // 初始化仅调用本机状态接口。
  state = await api('/api/state'); input = structuredClone(state.product.defaults); render(); // 授权后才初始化表单。
} catch (error) { // 初始化失败不显示假数据。
  document.getElementById('demo-app').textContent = '工作台无法加载：' + error.message; // 安全文本提示。
} // 结束初始化。
