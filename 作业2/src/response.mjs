/** 包装成功响应；入参为业务数据；出参为统一对象；不执行外部动作，数据原样放入 data。 */
export function success(data) { // 接口成功与业务状态分别表达。
  return { ok: true, data, error: { code: '', msg: '' } }; // 包含 manual 等业务状态仍可表示接口成功。
} // 结束成功封装。
/** 包装失败响应；入参为错误码和中文信息；出参为统一对象；不附带内部异常或业务来源。 */
export function failure(code, msg) { // 拒绝时不返回来源，防止越权信息泄露。
  return { ok: false, data: null, error: { code, msg } }; // 失败数据始终为空。
} // 结束失败封装。
