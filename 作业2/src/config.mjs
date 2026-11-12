import { readFile, realpath } from 'node:fs/promises'; // 使用原生异步文件读取。
import { dirname, resolve, sep } from 'node:path'; // 校验数据目录边界。
import { fileURLToPath } from 'node:url'; // 将模块地址转换为本地路径。
import { parse } from 'yaml'; // 唯一新增依赖，仅解析配置。
export const CONFIG_PATH = fileURLToPath(new URL('./config.yaml', import.meta.url)); // 固定唯一配置入口。
/** 校验普通对象；入参为待检查值；出参为布尔值；非法值返回 false。 */
export function isObject(value) { // 数组和空值不能充当契约对象。
  return value !== null && typeof value === 'object' && !Array.isArray(value); // 显式拒绝宽松类型转换。
} // 结束对象检查。
/** 校验配置；入参为解析后的配置对象；出参为原对象；无效时抛出不含配置原文的异常。 */
export function validateConfig(config) { // 启动前检查，不回退到隐藏默认配置。
  if (!isObject(config)) throw new Error('CONFIG_INVALID：配置必须是对象'); // 空配置停止启动。
  for (const key of ['server', 'project', 'access', 'data', 'rules', 'review']) { // 所有运行配置段均必须存在。
    if (!isObject(config[key])) throw new Error('CONFIG_INVALID：缺少配置段'); // 不输出可能含敏感值的配置。
  } // 结束配置段检查。
  const { server, project, access, data, rules, review } = config; // 读取已校验的配置段。
  if (server.host !== '127.0.0.1') throw new Error('CONFIG_INVALID：仅允许监听 127.0.0.1'); // 防止演示权限被当成公网鉴权。
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) throw new Error('CONFIG_INVALID：端口无效'); // 拒绝字符串端口和越界值。
  for (const key of ['maxBodyBytes', 'requestTimeoutMs']) { // 校验 HTTP 限额。
    if (!Number.isSafeInteger(server[key]) || server[key] < 1) throw new Error('CONFIG_INVALID：请求限额无效'); // 禁止无限请求体与负超时。
  } // 结束服务限额检查。
  if (project.projectId !== 'fsg-production-handover' || access.identity !== 'operator' || access.recordId !== 'HND-DEMO-001') throw new Error('CONFIG_INVALID：超出课堂授权范围'); // 配置不能扩大本阶段范围。
  if (!Array.isArray(project.modules) || project.modules.length !== 1 || project.modules[0]?.id !== project.projectId) throw new Error('CONFIG_INVALID：模块范围无效'); // 模块不能绕过项目边界。
  if (!isObject(project.pipeline) || project.pipeline.projectId !== project.projectId || project.pipeline.attemptId !== project.attemptId) throw new Error('CONFIG_INVALID：追溯关系无效'); // 避免迁移后绑定错项目。
  if (typeof project.assignment !== 'string' || typeof project.modules[0].title !== 'string') throw new Error('CONFIG_INVALID：项目元数据无效'); // 保证页面元数据可用。
  if (typeof data.fixturePath !== 'string' || !/^data\/[A-Za-z0-9_-]+\.json$/.test(data.fixturePath)) throw new Error('CONFIG_INVALID：数据路径无效'); // 禁止配置读取任意本地文件。
  if (typeof rules.version !== 'string' || !rules.version.trim()) throw new Error('CONFIG_INVALID：缺少规则版本'); // 结果必须能追溯规则。
  for (const key of ['maxAgeMinutes', 'maxRequestLength', 'maxFieldLength', 'maxItems', 'maxItemLength']) { // 校验规则阈值。
    if (!Number.isSafeInteger(rules[key]) || rules[key] < 1) throw new Error('CONFIG_INVALID：规则阈值无效'); // 错误阈值停止启动。
  } // 结束规则阈值检查。
  if (typeof review.journalPath !== 'string' || !/^var\/[A-Za-z0-9_-]+\.jsonl$/.test(review.journalPath)) throw new Error('CONFIG_INVALID：复核日志路径无效'); // 审计文件不能覆盖原始资料。
  for (const key of ['maxJournalBytes', 'maxEvents', 'listLimit', 'maxReasons']) { // 复核容量和字段数量必须明确。
    if (!Number.isSafeInteger(review[key]) || review[key] < 1) throw new Error('CONFIG_INVALID：复核日志限额无效'); // 不允许无限日志或隐式默认值。
  } // 结束复核限额检查。
  return config; // 返回验证后的配置，不加载任何业务数据。
} // 结束配置校验。
/** 加载唯一 YAML；入参为配置路径（默认模块旁 config.yaml）；出参为已校验对象；失败时抛出固定中文异常。 */
export async function loadConfig(path = CONFIG_PATH) { // 不依赖启动时所在目录。
  try { // 统一屏蔽文件内容与解析错误原文。
    const content = await readFile(path, 'utf8'); // 只读取配置，不读取业务样本。
    return validateConfig(parse(content, { maxAliasCount: 0, uniqueKeys: true })); // 禁止别名展开及重复键。
  } catch { // 配置缺失、格式错误及契约错误均停止启动。
    throw new Error('CONFIG_INVALID：请检查 config.yaml 的存在、格式和取值'); // 不泄露路径及敏感值。
  } // 结束配置异常处理。
} // 结束配置加载。
/** 创建延迟数据读取器；入参为配置及配置路径；出参为异步读取函数；创建时不读取业务数据。 */
export function createSnapshotReader(config, path = CONFIG_PATH) { // 由调用方在权限通过后使用。
  /** 读取合成快照；入参无；出参为新解析对象；读取失败或越界时抛出固定异常。 */
  return async function readSnapshot() { // 每次读取新对象，避免多个请求共享可变记录。
    try { // 防止符号链接绕过 data 目录。
      const root = await realpath(resolve(dirname(path), 'data')); // 获取真实数据目录。
      const target = await realpath(resolve(dirname(path), config.data.fixturePath)); // 获取实际文件路径。
      if (!target.startsWith(root + sep)) throw new Error('越界'); // 拒绝目录之外的文件。
      return JSON.parse(await readFile(target, 'utf8')); // 此处才发生业务数据读取。
    } catch { // 文件缺失、非法 JSON 和路径越界统一处理。
      throw new Error('SOURCE_UNAVAILABLE：合成来源不可用'); // 不暴露文件内容。
    } // 结束快照异常处理。
  }; // 返回延迟读取器。
} // 结束读取器创建。
