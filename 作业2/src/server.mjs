import http from 'node:http'; // 只使用原生 HTTP。
import { readFile } from 'node:fs/promises'; // 只读静态文件。
import { resolve } from 'node:path'; // 解析直接运行入口。
import { pathToFileURL } from 'node:url'; // 比较模块地址。
import { loadConfig, createSnapshotReader, isObject } from './config.mjs'; // 配置与延迟读取。
import { accessError, getDemoProduct, runProjectDemo, evaluateProjectDemo, demoScenarios } from './runtime.js'; // 服务端共用规则。
import { success, failure } from './response.mjs'; // 统一响应。
const staticFiles = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]); // 不发布配置、数据或服务端源码。
/** 创建公开错误；入参为状态、错误码和中文信息；出参为 Error；不携带内部原文。 */
function requestError(status, code, message) { // 只允许受控信息返回客户端。
  return Object.assign(new Error(message), { status, code }); // 标记可公开异常。
} // 结束异常构造。
/** 读取请求；入参为请求和字节上限；出参为 JSON 对象；非法类型或超限时抛出受控错误。 */
async function readJson(request, maxBytes) { // 不记录请求原文。
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw requestError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json'); // 拒绝普通跨站表单。
  const chunks = []; // 仅缓存限额内的数据。
  let size = 0; // 按字节而非字符统计。
  for await (const chunk of request) { // HTTP 接收时间由配置限制。
    size += chunk.length; // 累加真实字节数。
    if (size <= maxBytes) chunks.push(chunk); // 超限后丢弃后续数据。
  } // 结束请求接收。
  if (size > maxBytes) throw requestError(413, 'PAYLOAD_TOO_LARGE', '请求体超过配置上限'); // 不解析超限内容。
  try { // 屏蔽 JSON 异常原文。
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); // 内容仅作为数据。
    if (!isObject(body)) throw new Error('不是对象'); // 拒绝 null 和数组。
    return body; // 返回合法对象。
  } catch { // 不回显解析错误中的敏感值。
    throw requestError(400, 'INVALID_JSON', '请求体必须是合法 JSON 对象'); // 固定中文错误。
  } // 结束解析处理。
} // 结束请求读取。
/** 发送业务响应；入参为响应、状态和统一对象；出参无；连接失败交由 HTTP 处理。 */
function sendJson(response, status, body) { // 成功和失败使用一致的头。
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); // 防止缓存来源信息。
  response.end(JSON.stringify(body)); // 仅响应当前本机请求，不执行外部业务发送。
} // 结束 JSON 发送。
/** 创建服务；入参为已验证配置和可注入读取器；出参为未监听服务；创建过程不读取业务数据。 */
export function createDemoServer(config, readSnapshot = createSnapshotReader(config)) { // 测试可统计读取次数。
  const context = { config, readSnapshot }; // 不设置全局业务快照。
  const server = http.createServer(handleRequest); // 不引入中间件。
  server.requestTimeout = config.server.requestTimeoutMs; // 请求接收超时。
  server.headersTimeout = Math.min(config.server.requestTimeoutMs, 60000); // 请求头接收超时。
  server.on('clientError', handleClientError); // 协议错误也保持统一结构。
  /** 处理协议错误；入参为错误和连接；出参无；关闭连接并隐藏内部异常。 */
  function handleClientError(error, socket) { // 不打印内部错误原文。
    if (!socket.writable) return; // 已关闭则不再写入。
    const body = JSON.stringify(failure('BAD_HTTP_REQUEST', 'HTTP 请求格式无效')); // 不携带业务数据。
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\nContent-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body); // 明确长度并关闭。
  } // 结束协议错误处理。
  /** 检查演示访问；入参为请求、项目和任务；出参无；拒绝时抛出 403，不调用读取器。 */
  function authorize(request, projectId, input) { // 必须由服务端检查，不能只隐藏前端按钮。
    if (request.headers['x-demo-identity'] !== config.access.identity || request.headers['x-demo-identity'] !== input?.identity) throw requestError(403, 'FORBIDDEN', '演示身份未授权'); // 头和任务保持一致，但仍不是真实凭证。
    const denied = accessError(config, projectId, input); // 检查项目、模块和记录范围。
    if (denied) throw requestError(403, denied, '请求不在授权演示范围'); // 先拒绝再读取数据。
  } // 结束服务端权限检查。
  /** 分派请求；入参为请求和响应；出参为异步完成；异常转为统一失败响应且不回显输入。 */
  async function handleRequest(request, response) { // 所有业务均在本机执行。
    try { // 集中处理接口异常。
      const expectedHost = config.server.host + ':' + server.address().port; // 使用实际监听端口。
      if (request.headers.host !== expectedHost || (request.headers.origin && request.headers.origin !== 'http://' + expectedHost)) throw requestError(403, 'ORIGIN_FORBIDDEN', '仅允许当前本机来源'); // 限制跨站及主机头绕过，不替代正式鉴权。
      const url = new URL(request.url, 'http://' + expectedHost); // 仅用于解析本机路径。
      if (staticFiles.has(url.pathname)) { // 静态资源限定固定映射。
        if (!['GET', 'HEAD'].includes(request.method)) throw requestError(405, 'METHOD_NOT_ALLOWED', '静态资源仅支持 GET 或 HEAD'); // 没有文件写接口。
        const [file, type] = staticFiles.get(url.pathname); // 取可信文件名。
        const content = await readFile(new URL(file, import.meta.url)); // 用户路径不传入文件系统。
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); // 页面只访问同源资源。
        response.end(request.method === 'HEAD' ? undefined : content); // 静态资源保留原格式。
        return; // 结束静态响应。
      } // 结束静态分支。
      if (!['/api/state', '/api/run', '/api/evaluate'].includes(url.pathname)) throw requestError(404, 'NOT_FOUND', '接口或资源不存在'); // 配置、数据和旧 project.json 均不可下载。
      if (request.method !== (url.pathname === '/api/state' ? 'GET' : 'POST')) throw requestError(405, 'METHOD_NOT_ALLOWED', '请求方法不支持'); // GET 不能执行业务核对。
      if ([...url.searchParams].length) throw requestError(400, 'UNKNOWN_QUERY', '接口不接受查询参数'); // 不保留旧平台参数绕过路径。
      if (url.pathname === '/api/state') { // 初始化表单也读取合成来源。
        authorize(request, config.project.projectId, { identity: request.headers['x-demo-identity'] }); // 必须先通过演示授权。
        let product; // 仅返回必要展示信息。
        try { product = getDemoProduct(config, await readSnapshot()); } catch { throw requestError(503, 'SOURCE_UNAVAILABLE', '合成来源不可用，请检查数据文件'); } // 不用猜测填充表单。
        sendJson(response, 200, success({ projectId: config.project.projectId, assignment: config.project.assignment, modules: config.project.modules, ruleVersion: config.rules.version, maxAgeMinutes: config.rules.maxAgeMinutes, limits: { request: config.rules.maxRequestLength, field: config.rules.maxFieldLength }, product, scenarios: demoScenarios })); // 不返回完整配置或环境变量。
        return; // 完成状态响应。
      } // 结束初始化分支。
      const body = await readJson(request, config.server.maxBodyBytes); // 只接受有界 JSON。
      for (const key of Object.keys(body)) if (!['projectId', 'input'].includes(key)) throw requestError(400, 'UNKNOWN_FIELD', '请求包含未定义字段'); // 禁止顶层参数扩展权限。
      if (typeof body.projectId !== 'string' || !isObject(body.input)) throw requestError(400, 'INVALID_INPUT', '需要 projectId 字符串和 input 对象'); // 缺字段不自动赋权。
      authorize(request, body.projectId, body.input); // 在所有业务读取前检查权限。
      if (url.pathname === '/api/evaluate') { // 授权调用者才能评估合成场景。
        for (const key of Object.keys(body.input)) if (!['identity', 'moduleId', 'recordId'].includes(key)) throw requestError(400, 'UNKNOWN_FIELD', '评估只接受身份、模块和记录范围'); // 不接受任意评估数据。
        sendJson(response, 200, success(await evaluateProjectDemo(context))); // 返回实际场景结果。
        return; // 完成评估响应。
      } // 结束评估分支。
      sendJson(response, 200, success(await runProjectDemo(body.projectId, body.input, context))); // 接口成功与 data.status 的业务结论分开。
    } catch (error) { // 错误响应不携带来源。
      if (response.destroyed || response.headersSent) return; // 不重复写头。
      const controlled = Number.isInteger(error.status) && typeof error.code === 'string'; // 仅公开受控异常。
      sendJson(response, controlled ? error.status : 500, failure(controlled ? error.code : 'INTERNAL_ERROR', controlled ? error.message : '服务暂不可用，请本地检查配置与文件')); // 屏蔽堆栈和敏感原文。
    } // 结束接口异常处理。
  } // 结束请求分派。
  return server; // 由入口或测试决定监听生命周期。
} // 结束服务创建。
/** 启动本地服务；入参无；出参为监听服务；配置错误或端口冲突时拒绝启动。 */
export async function startServer() { // 不在启动时读取业务样本。
  const config = await loadConfig(); // 配置错误必须停止。
  const server = createDemoServer(config); // 创建延迟读取器。
  /** 等待监听；入参为完成和失败回调；出参无；监听错误拒绝。 */
  await new Promise(function listen(resolveListen, rejectListen) { // 启动失败不能被吞掉。
    server.once('error', rejectListen); // 接收端口冲突等异常。
    /** 监听完成；入参无；出参无；移除启动错误回调后完成等待。 */
    function ready() { server.off('error', rejectListen); resolveListen(); } // 确认端口已建立。
    server.listen(config.server.port, config.server.host, ready); // 地址和端口均来自配置。
  }); // 结束监听等待。
  console.log('合成演示已启动：http://' + config.server.host + ':' + config.server.port); // 不打印请求或来源。
  return server; // 返回供调用方关闭。
} // 结束服务启动。
/** 处理启动失败；入参为异常；出参无；输出固定提示并设置非零退出码。 */
function startupFailed(error) { // 不输出堆栈。
  console.error(error.code === 'EADDRINUSE' ? '启动失败：配置端口已被占用，请修改 config.yaml' : '启动失败：请检查 config.yaml、依赖及 Node.js 版本'); // 提供可操作提示。
  process.exitCode = 1; // 方便验证脚本判断。
} // 结束启动错误处理。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) startServer().catch(startupFailed); // 被测试导入时不自动启动。
