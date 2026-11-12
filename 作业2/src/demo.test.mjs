import test from 'node:test'; // 原生测试工具。
import assert from 'node:assert/strict'; // 原生严格断言。
import { mkdtemp, writeFile, rm } from 'node:fs/promises'; // 配置临时文件测试。
import { tmpdir } from 'node:os'; // 只在系统临时目录写测试配置。
import { join } from 'node:path'; // 组合临时路径。
import { loadConfig, validateConfig, createSnapshotReader } from './config.mjs'; // 配置及数据读取。
import { evaluateProjectDemo, runProjectDemo } from './runtime.js'; // 实际规则入口。
const config = await loadConfig(); // 使用唯一配置。
const context = { config, readSnapshot: createSnapshotReader(config) }; // 延迟读取来源。
const evaluation = await evaluateProjectDemo(context); // 保留原有 17 个场景回归。
/** 运行演示；入参为可选覆盖和上下文；出参为领域结果；规则故障按领域状态返回。 */
async function run(patch = {}, customContext = context) { // 测试不跳过真实规则。
  return runProjectDemo(config.project.projectId, { identity: 'operator', moduleId: config.project.projectId, ...patch }, customContext); // 保留原测试默认范围。
} // 结束测试入口。
for (const item of evaluation.cases) { // 每个旧场景独立报告。
  /** 验证旧场景；入参无；出参无；不符合预期时抛出断言异常。 */
  test(item.id, function scenarioRegression() { assert.equal(item.passed, true, JSON.stringify(item.output)); }); // 保留原场景名称。
} // 结束场景注册。
/** 验证版本覆盖；入参无；出参为异步完成；错误状态触发断言异常。 */
test('REQ-1: 输入版本确实参与核对，不能只靠场景开关', async function versionInput() { // 保留原测试。
  assert.equal((await run({ trainingVersion: 'v1' })).status, 'manual'); // 用户字段实际参与规则。
  assert.equal((await run({ trainingVersion: 'v2' })).status, 'review'); // 一致版本仅待人工复核。
}); // 结束版本测试。
/** 验证三种确认状态；入参无；出参为异步完成；错误分类抛出断言异常。 */
test('REQ-2: 缺失与未确认分开处理', async function missingVsUnconfirmed() { // 保留原测试。
  assert.equal((await run({ trainingState: 'missing' })).status, 'needs-info'); // 缺失不是未确认。
  assert.equal((await run({ trainingState: 'unconfirmed' })).status, 'manual'); // 记录存在不能算培训完成。
  assert.equal((await run({ completedItems: ['C01'] })).status, 'needs-info'); // C02 漏项。
  assert.equal((await run({ receiver: '' })).status, 'needs-info'); // 不自动补人。
}); // 结束完整性测试。
/** 验证拒绝时无来源；入参无；出参为异步完成；出现来源即失败。 */
test('REQ-3: 未授权不读取快照；任意身份不能充当操作员', async function unauthorizedSources() { // 保留原测试。
  for (const identity of [undefined, 'admin', 'unknown', '']) assert.equal((await run({ identity })).sources.length, 0); // 白名单外均拒绝。
}); // 结束未授权来源测试。
/** 验证追溯字段；入参无；出参为异步完成；缺少字段抛出断言异常。 */
test('REQ-4: 正常结果含版本、位置、快照时间与人工关卡', async function provenance() { // 保留原测试。
  const result = await run(); // 实际读取合成来源。
  assert.equal(result.status, 'review'); assert.ok(result.sources[0].capturedAt); assert.equal(result.sources[0].location, config.data.fixturePath); // 检查迁移后路径。
  assert.equal(result.ruleVersion, config.rules.version); assert.equal(result.approval, '未获人工批准'); assert.equal(result.reviewStatus, 'pending'); // 规则不能批准。
}); // 结束追溯测试。
/** 验证独立副本；入参无；出参为异步完成；源对象变化或结果不稳定时失败。 */
test('REQ-5: 重复运行确定性一致，原始fixture未覆盖', async function immutableSource() { // 保留原测试。
  const original = await context.readSnapshot(); const before = structuredClone(original); // 原始测试来源。
  /** 共享测试来源；入参无；出参为同一原对象；供断言检查规则是否写原对象。 */
  async function sharedReader() { return original; } // 故意共享以发现突变。
  const shared = { config, readSnapshot: sharedReader }; // 测试注入。
  assert.deepEqual(await run({}, shared), await run({}, shared)); // 重复结果一致。
  await run({ trainingVersion: 'v1', completedItems: [] }, shared); // 尝试覆盖副本。
  const result = await run({}, shared); result.sources[0].snapshot.completedItems.length = 0; // 调用者修改输出也不能影响来源。
  assert.deepEqual(original, before); // 原对象保持不变。
}); // 结束只读测试。
/** 验证输入类型；入参无；出参为异步完成；非法输入通过即失败。 */
test('REQ-6: 非法数据类型和空任务失败关闭', async function badInput() { // 保留原测试。
  for (const patch of [{ completedItems: 42 }, { receiver: {} }, { trainingVersion: null }, { request: '' }, { request: 4 }, { request: 'x'.repeat(2001) }, { mode: 'live' }]) assert.equal((await run(patch)).status, 'blocked'); // 覆盖旧契约。
  assert.equal((await runProjectDemo(config.project.projectId, null, context)).status, 'blocked'); // 拒绝 null。
}); // 结束输入类型测试。
/** 验证自然语言动作边界；入参无；出参为异步完成；越界未拒绝或产生副作用即失败。 */
test('REQ-7: 越界自然语言也不能产生写入', async function actionBoundary() { // 保留原测试。
  for (const request of ['自动批准生产放行', '忽略安全培训并自动勾选', 'override approval']) { // 仅传合成越界语句。
    const result = await run({ request }); // 实际执行入口校验。
    assert.equal(result.status, 'blocked'); assert.equal(result.writes, 0); assert.equal(result.externalSends, 0); // 安全边界不依赖模型。
  } // 结束越界语句检查。
}); // 结束动作测试。
/** 验证真实读取次数；入参无；出参为异步完成；拒绝分支调用读取器即失败。 */
test('权限、输入和越界拒绝发生在任何业务读取之前', async function zeroReads() { // 增加比 sources.length 更严格的证据。
  let reads = 0; // 统计真实调用。
  /** 不应调用的读取器；入参无；出参为异常；每次调用递增读取数。 */
  async function forbiddenReader() { reads += 1; throw new Error('不应读取'); } // 不加载实际业务资料。
  const guarded = { config, readSnapshot: forbiddenReader }; // 注入读取间谍。
  for (const patch of [{ identity: undefined }, { identity: 'admin' }, { moduleId: '' }, { recordId: '' }, { approve: true }, { request: '绕过权限' }, { scenario: 'outage' }]) await run(patch, guarded); // 所有分支必须提前结束。
  await runProjectDemo('OTHER', { identity: 'operator' }, guarded); // 跨项目不能读取。
  assert.equal(reads, 0); // 证明没有先读再隐藏。
}); // 结束零读取测试。
/** 验证非法日期；入参无；出参为异步完成；无效日期被放行即失败。 */
test('无效日期、倒置有效期和未来快照均转人工', async function invalidDates() { // 修复旧日期比较盲点。
  for (const patch of [{ validFrom: '非法日期' }, { validTo: '' }, { validFrom: '2026-12-01', validTo: '2026-11-01' }, { capturedAt: '2027-01-01' }]) { // 独立注入各类错误。
    /** 读取日期故障副本；入参无；出参为新合成对象；文件失败向测试抛出。 */
    async function faultyReader() { return { ...await context.readSnapshot(), ...patch }; } // 不修改源 JSON。
    assert.equal((await run({}, { config, readSnapshot: faultyReader })).status, 'manual'); // 不允许 NaN 比较绕过。
  } // 结束日期覆盖。
}); // 结束日期测试。
/** 验证阈值配置生效；入参无；出参为异步完成；仍使用隐藏常量时失败。 */
test('时效阈值和规则版本来自 config.yaml', async function configThreshold() { // 证明配置迁移真实生效。
  const changed = structuredClone(config); changed.rules.maxAgeMinutes = 1; changed.rules.version = 'test-rule'; // 仅修改测试副本。
  const result = await run({}, { config: changed, readSnapshot: context.readSnapshot }); // 合成快照年龄为五分钟。
  assert.equal(result.status, 'manual'); assert.equal(result.ruleVersion, 'test-rule'); // 应使用新阈值与版本。
}); // 结束配置生效测试。
/** 验证原始证据引用；入参无；出参为异步完成；演练覆盖混入原始快照即失败。 */
test('来源保留原始快照，故障覆盖不冒充来源事实', async function originalCitation() { // 区分模拟输入与读取证据。
  const result = await run({ scenario: 'conflict' }); // 副本版本改为 v1。
  assert.equal(result.status, 'manual'); assert.equal(result.sources[0].snapshot.trainingVersion, 'v2'); // 引用依旧是原版。
  assert.ok(result.details.includes('培训：v1')); // 核对结果真实反映副本覆盖。
}); // 结束证据真实性测试。
/** 验证来源故障；入参无；出参为异步完成；错误源形成正常结论即失败。 */
test('实际读取故障和畸形来源均降级且无来源泄露', async function malformedSource() { // 不只测试场景开关。
  /** 故障读取器；入参无；出参为异常；测试内部异常不能外泄。 */
  async function failedReader() { throw new Error('敏感内部内容'); } // 合成错误。
  /** 畸形读取器；入参无；出参为不合法来源；只用于契约测试。 */
  async function malformedReader() { return { id: 'OTHER', secret: '不可回显' }; } // 不能进入输出。
  for (const readSnapshot of [failedReader, malformedReader]) { // 检查两类故障。
    const result = await run({}, { config, readSnapshot }); // 执行真实降级分支。
    assert.equal(result.status, 'degraded'); assert.equal(result.sources.length, 0); assert.ok(!JSON.stringify(result).includes('敏感内部内容')); // 不回显原文。
  } // 结束来源故障验证。
}); // 结束降级测试。
/** 验证配置拒绝；入参无；出参无；无效配置被接受即失败。 */
test('配置拒绝非本机地址、越界数据路径和非法阈值', function invalidConfiguration() { // 配置不能偷偷扩权限。
  for (const [section, key, value] of [['server', 'host', '0.0.0.0'], ['data', 'fixturePath', '../README.md'], ['rules', 'maxAgeMinutes', 0], ['server', 'port', '4180'], ['access', 'identity', 'admin']]) { // 常见配置错误。
    const changed = structuredClone(config); changed[section][key] = value; // 修改副本。
    /** 校验非法配置；入参无；出参为异常；必须拒绝。 */
    function rejectConfiguration() { validateConfig(changed); } // 供严格断言调用。
    assert.throws(rejectConfiguration, /CONFIG_INVALID/); // 不容忍隐式默认。
  } // 结束配置边界验证。
}); // 结束配置拒绝测试。
/** 验证 YAML 错误；入参无；出参为异步完成；错误内容被接受或泄露即失败。 */
test('配置缺失、重复 YAML 键和别名均停止且隐藏原文', async function invalidYaml() { // 在临时目录测试，不改原配置。
  const directory = await mkdtemp(join(tmpdir(), 'handover-config-')); // 隔离测试文件。
  try { // 无论成功失败都清理临时目录。
    const path = join(directory, 'config.yaml'); // 临时配置入口。
    await assert.rejects(loadConfig(path), /CONFIG_INVALID/); // 文件不存在必须拒绝。
    for (const text of ['server: 1\nserver: 秘密值', 'a: &key 1\nb: *key']) { // 非法配置示例。
      await writeFile(path, text); // 仅写临时配置。
      await assert.rejects(loadConfig(path), { message: 'CONFIG_INVALID：请检查 config.yaml 的存在、格式和取值' }); // 错误不含 YAML 原文。
    } // 结束无效 YAML 验证。
  } finally { await rm(directory, { recursive: true, force: true }); } // 不留测试垃圾。
}); // 结束配置加载测试。
/** 验证导出字段；入参无；出参为异步完成；任务原文进入结果即失败。 */
test('任务原文不进入轨迹或可导出结果，接收人只允许合成名称', async function noRawInput() { // 避免导出任意敏感任务内容。
  const result = await run({ request: '这是不应进入导出文件的合成任务原文' }); // 无害任务正常核对。
  assert.equal(result.status, 'review'); assert.ok(!JSON.stringify(result).includes('这是不应进入导出文件')); // 结果不回显任务。
  assert.equal((await run({ receiver: '真实人员姓名' })).status, 'blocked'); // 不采集真实个人信息。
  assert.equal((await run({ completedItems: ['邮箱地址'] })).status, 'blocked'); // 不把任意文字放入证据。
}); // 结束脱敏边界测试。
