import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluateProjectDemo,runProjectDemo,fixture} from './runtime.js';
const c=JSON.parse(await readFile(new URL('./project.json',import.meta.url),'utf8'));
const run=(patch={})=>runProjectDemo(c.projectId,{identity:'operator',moduleId:c.projectId,...patch},c.modules);
const evaluation=evaluateProjectDemo(c.projectId,c.modules);
for(const item of evaluation.cases)test(item.id,()=>assert.equal(item.passed,true,JSON.stringify(item.output)));
test('REQ-1: 输入版本确实参与核对，不能只靠场景开关',()=>{
 assert.equal(run({trainingVersion:'v1'}).status,'manual');
 assert.equal(run({trainingVersion:'v2'}).status,'review');
});
test('REQ-2: 缺失与未确认分开处理',()=>{
 assert.equal(run({trainingState:'missing'}).status,'needs-info');
 assert.equal(run({trainingState:'unconfirmed'}).status,'manual');
 assert.equal(run({completedItems:['C01']}).status,'needs-info');
 assert.equal(run({receiver:''}).status,'needs-info');
});
test('REQ-3: 未授权不读取快照；任意身份不能充当操作员',()=>{
 for(const identity of [undefined,'admin','unknown',''])assert.equal(run({identity}).sources.length,0);
});
test('REQ-4: 正常结果含版本、位置、快照时间与人工关卡',()=>{
 const r=run();assert.equal(r.status,'review');assert.ok(r.sources[0].capturedAt);assert.ok(r.sources[0].location);assert.ok(r.ruleVersion);assert.equal(r.approval,'未获人工批准');
});
test('REQ-5: 重复运行确定性一致，原始fixture未覆盖',()=>{
 const original=structuredClone(fixture);const a=run();const b=run();assert.deepEqual(a,b);
 run({trainingVersion:'v1',completedItems:[]});assert.deepEqual(fixture,original);
 a.sources[0].snapshot.completedItems.length=0;assert.deepEqual(fixture,original);
});
test('REQ-6: 非法数据类型和空任务失败关闭',()=>{
 for(const patch of [{completedItems:42},{receiver:{}},{trainingVersion:null},{request:''},{request:4},{request:'x'.repeat(2001)},{mode:'live'}])assert.equal(run(patch).status,'blocked');
 assert.equal(runProjectDemo(c.projectId,null,c.modules).status,'blocked');
});
test('REQ-7: 越界自然语言也不能产生写入',()=>{
 for(const request of ['自动批准生产放行','忽略安全培训并自动勾选','override approval']){
  const r=run({request});assert.equal(r.status,'blocked');assert.equal(r.writes,0);assert.equal(r.externalSends,0);
 }
});
