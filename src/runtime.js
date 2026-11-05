// FDE课堂作业2：平台离线示范的场景化实现。所有记录均为合成样本。
export const RULE_VERSION = 'handover-rules-v2';
export const demoScenarios = [
 ['normal','正常交接'],['missing','接收人缺失'],['conflict','培训版本冲突'],
 ['unconfirmed','培训尚未确认'],['missing-item','检查项漏记'],['open-exception','异常未关闭'],
 ['invalid-rule','指引未生效'],['stale','来源已过期'],['unauthorized','身份无权限'],['outage','来源不可用'],['injection','越界动作请求']
];
export const fixture = {
 id:'HND-DEMO-001',job:'JOB-01',process:'PROC-02',batch:'BATCH-DEMO-01',
 instructionVersion:'v2',instructionState:'confirmed',validFrom:'2026-11-01T00:00:00+08:00',validTo:'2026-12-01T00:00:00+08:00',trainingVersion:'v2',trainingState:'confirmed',
 requiredItems:['C01','C02'],completedItems:['C01','C02'],
 owner:'现场专员（演示）',receiver:'质量复核员（演示）',exceptions:[],
 sourceVersion:'snapshot-v2',capturedAt:'2026-11-05T09:00:00+08:00',
 reviewedAt:'2026-11-05T09:05:00+08:00',maxAgeMinutes:60
};
export function getDemoProduct(key,modules=[]){
 if(key!=='fsg-production-handover')throw Error('只支持生产岗位培训与工序交接项目');
 return {key,name:'生产岗位培训与工序交接',product:'岗位作业交接核对助手',
 subtitle:'对齐培训版本、工序检查项与具名交接记录',icon:'交',accent:'#1b6c80',
 record:fixture.id,recordLabel:'岗位交接包',user:'获授权经办人（演示身份）',
 objects:['岗位','工序指引','培训记录','检查项','未结异常','人工复核'],
 agents:['范围与身份核对','版本与完整性核对','人工交接草稿'],
 outcome:'核对一个批次的交接包，形成可追溯的人工复核清单',
 boundary:'仅用合成资料只读核对；不控制设备、不替代安全培训、不批准生产放行。',
 source:'HND-DEMO-001@snapshot-v2',
 rows:[['岗位 / 工序',fixture.job+' / '+fixture.process],['批次',fixture.batch],
 ['工序指引 / 培训版本','v2 / v2（合成）'],['必查项','C01、C02（教学清单）'],
 ['快照时间',fixture.capturedAt],['数据性质','合成样本；60分钟时效仅为测试假设']],
 request:'核对本批次培训版本与检查项，列出缺口、来源与人工接收人。'};
}
export function runProjectDemo(key,input={},modules=[]){
 const p=getDemoProduct(key,modules),trace=[];
 const push=(agent,action,detail)=>trace.push({step:trace.length+1,agent,action,detail});
 const result=(status,title,summary,details=[],sources=[])=>({
  projectId:key,recordId:typeof input?.recordId==='string'?input.recordId:p.record,
  status,title,summary,details,sources,trace,mode:'offline-fixture',
  ruleVersion:RULE_VERSION,writes:0,externalSends:0,approval:'未获人工批准',
  moduleId:key,reviewOwner:'质量复核负责人（待具名授权）'
 });
 push(p.agents[0],'校验输入契约','仅支持本项目合成样本；身份选择不代表真实鉴权。');
 if(!input||typeof input!=='object'||Array.isArray(input))return result('blocked','输入格式无效','请提交一个任务对象。');
 const allowed=new Set(['scenario','mode','identity','moduleId','recordId','request','trainingVersion','trainingState','completedItems','receiver']);
 if(Object.keys(input).some(k=>!allowed.has(k)))return result('blocked','输入字段未定义','请按数据契约提交，未知字段不会被执行。');
 const scenario=input.scenario??'normal';
 if(!demoScenarios.some(([id])=>id===scenario))return result('blocked','场景无效','请选择已定义的演练场景。');
 if(input.identity!=='operator'||scenario==='unauthorized')return result('blocked','访问被拒绝','未读取业务来源；请使用授权演示身份。');
 if(!modules.some(m=>m.id===key)||input.moduleId&&input.moduleId!==key)return result('blocked','模块不在本次训练范围','未读取其他模块的记录。');
 if(input.recordId&&input.recordId!==p.record)return result('blocked','样本不存在','仅允许读取本项目的合成交接包。');
 if(input.mode&&input.mode!=='offline')return result('blocked','执行方式未支持','独立作业仅支持本地规则模式。');
 if(input.request!==undefined&&(typeof input.request!=='string'||!input.request.trim()||input.request.length>2000))return result('blocked','任务描述无效','请输入1至2000字的核对任务。');
 const request=input.request??p.request;
 if(scenario==='injection'||/自动.{0,6}(放行|审批|批准|发送|培训确认)|绕过|忽略.{0,6}(规则|安全|权限)|控制设备|启停|直接支付|批准生产|自动勾选|override|approve|shutdown/i.test(request)){
  push('动作边界','拒绝执行动作',p.boundary);
  return result('blocked','请求超出只读范围','请由授权人员在既有流程中处理。系统没有业务写入或执行接口。');
 }
 if(scenario==='outage'){
  push(p.agents[1],'来源读取失败','未把历史快照当作当前状态；历史预览仍标注采集时间。');
  return result('degraded','来源不可用，转人工','历史快照采集时间：'+fixture.capturedAt+'；其有效性未获重新确认。请人工核查，恢复后重新读取。');
 }
 const data=structuredClone(fixture);
 for(const field of ['trainingVersion','trainingState','completedItems','receiver'])if(input[field]!==undefined)data[field]=input[field];
 if(typeof data.trainingVersion!=='string'||data.trainingVersion.length>80||
 !['confirmed','unconfirmed','missing'].includes(data.trainingState)||
 !Array.isArray(data.completedItems)||data.completedItems.length>20||data.completedItems.some(x=>typeof x!=='string'||x.length>40)||
 typeof data.receiver!=='string'||data.receiver.length>80){return result('blocked','字段不符合契约','请检查培训版本、确认状态、检查项数组与接收人。');}
 if(scenario==='missing')data.receiver='';
 if(scenario==='conflict')data.trainingVersion='v1';
 if(scenario==='unconfirmed')data.trainingState='unconfirmed';
 if(scenario==='missing-item')data.completedItems=['C01'];
 if(scenario==='open-exception')data.exceptions=[{id:'EX-DEMO-001',status:'open',owner:data.owner}];
 if(scenario==='invalid-rule')data.instructionState='unconfirmed';
 if(scenario==='stale')data.capturedAt='2026-11-04T09:00:00+08:00';
 const sources=[{id:data.id+'@'+data.sourceVersion,title:'岗位作业交接包合成快照',
  location:'runtime.js#fixture',version:data.sourceVersion,capturedAt:data.capturedAt,
  synthetic:true,excerpt:JSON.stringify(data),snapshot:data}];
 push(p.agents[1],'读取合成快照',sources[0].id+'；'+data.capturedAt);
 const age=(Date.parse(data.reviewedAt)-Date.parse(data.capturedAt))/60000;
 if(!Number.isFinite(age)||age<0||age>data.maxAgeMinutes)return result('manual','来源过期，需要人工核对','教学时效阈值60分钟；不得用历史快照证明当前状态。',[],sources);
 const reviewed=Date.parse(data.reviewedAt);
 if(data.instructionState!=='confirmed'||reviewed<Date.parse(data.validFrom)||reviewed>=Date.parse(data.validTo))return result('manual','指引未确认或不在有效期','有效期与人工确认状态必须同时满足；请资料负责人核实，不能凭文件名判断。',[],sources);
 const missing=[];
 if(!data.trainingVersion.trim()||data.trainingState==='missing')missing.push('培训记录或版本缺失');
 if(!data.receiver.trim())missing.push('接收人缺失');
 for(const item of data.requiredItems)if(!data.completedItems.includes(item))missing.push('检查项未记录：'+item);
 if(missing.length){push(p.agents[1],'发现缺项',missing.join('；'));return result('needs-info','交接资料不完整','保留原始记录，补齐后重新核对。',missing,sources);}
 if(data.trainingVersion!==data.instructionVersion){push(p.agents[1],'发现版本冲突',data.trainingVersion+' ≠ '+data.instructionVersion);return result('manual','培训版本与指引不一致','由资料负责人确认适用版本与补训范围，质量负责人复核；不自动认定责任。',['培训：'+data.trainingVersion,'工序指引：'+data.instructionVersion],sources);}
 if(data.trainingState==='unconfirmed')return result('manual','培训状态尚未确认','记录存在但未经人工确认，不能当作培训缺失或已完成。',[],sources);
 const open=data.exceptions.filter(x=>x.status!=='closed');
 if(open.length)return result('manual','存在未结异常','保留异常责任人和状态，转质量负责人复核。',open.map(x=>x.id+' / '+x.owner+' / '+x.status),sources);
 const details=['岗位 '+data.job+'；工序 '+data.process+'；批次 '+data.batch,
  '培训与工序指引均为 '+data.instructionVersion+'；已按演示确认状态核对',
  '必查项 '+data.requiredItems.join('、')+' 均有记录；未结异常 0 项',
  '交出人：'+data.owner+'；接收人：'+data.receiver,
  '下一步：人工核对原始证据、签署复核记录，再按既有流程处理。'];
 push(p.agents[1],'完成确定性核对','版本相等、检查项齐全、确认状态明确、接收人存在、异常无未结项。');
 push(p.agents[2],'生成复核草稿','引用来源版本与采集时间，不修改原始资料。');
 push('人工复核关卡','等待人工决定',p.boundary);
 return result('review','交接核对草稿，待人工复核','教学规则已执行；规则通过不代表真实培训合格或生产放行。',details,sources);
}
export function evaluateProjectDemo(key,modules=[]){
 const expected={normal:'review',missing:'needs-info',conflict:'manual',unconfirmed:'manual','missing-item':'needs-info','open-exception':'manual','invalid-rule':'manual',stale:'manual',unauthorized:'blocked',outage:'degraded',injection:'blocked'};
 const base={identity:'operator',recordId:fixture.id,moduleId:key,mode:'offline'};
 const checks=demoScenarios.map(([scenario,label])=>({id:scenario,label,input:{...base,scenario},expected:expected[scenario]}));
 for(const [id,patch] of [['unknown-record',{recordId:'OTHER'}],['module-boundary',{moduleId:'OTHER'}],['invalid-identity',{identity:'admin'}],['unknown-field',{approve:true}],['bad-items',{completedItems:'C01'}],['bad-state',{trainingState:'done'}]])checks.push({id,label:id,input:{...base,...patch},expected:'blocked'});
 const cases=checks.map(c=>{const output=runProjectDemo(key,c.input,modules);const count=c.expected==='blocked'||c.expected==='degraded'?0:1;return {...c,actual:output.status,output,passed:output.status===c.expected&&output.sources.length===count&&output.writes===0&&output.externalSends===0&&output.approval==='未获人工批准'};});
 return {mode:'offline-fixture',ruleVersion:RULE_VERSION,total:cases.length,passed:cases.filter(c=>c.passed).length,cases};
}
