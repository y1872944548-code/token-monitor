import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLaunchThreadId} from '../src/launch-target.mjs';

test('global mode reopens using launch identity while selectedId stays null',()=>{
  const original='01a13949-b780-71a2-8863-a7f53db88ead',selected='01a13949-b780-71a2-8863-a7f53db88eae';
  const global={selectedId:null,window:{launchThreadId:original},scope:{mode:'all',threadId:selected}};
  assert.equal(resolveLaunchThreadId(undefined,global),original);
  assert.equal(global.selectedId,null);
  assert.equal(resolveLaunchThreadId(selected,global),selected);
  assert.equal(resolveLaunchThreadId(undefined,{selectedId:selected}),selected);
  assert.equal(resolveLaunchThreadId(undefined,{selectedId:null,scope:{threadId:original}}),original);
  assert.equal(resolveLaunchThreadId('bad',{window:{launchThreadId:'bad'}}),null);
});
