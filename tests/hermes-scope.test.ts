import {afterEach,beforeEach,describe,expect,it} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {execFileSync} from 'node:child_process';
import {resolveHermesScope,hermesRecallRange} from '../src/memory/hermes-scope.ts';
import {HermesMemoryRetriever} from '../src/memory/hermes-retriever.ts';
import {SkillCollector} from '../src/skills/collector.ts';
import {makeHermesDatabase} from './memory-support.ts';
import {put} from './support.ts';

let base:string,home:string,root:string;
beforeEach(()=>{base=fs.mkdtempSync(path.join(os.tmpdir(),'jev-hermes-scope-'));home=path.join(base,'home');root=path.join(base,'CPA');fs.mkdirSync(home);fs.mkdirSync(root);});
afterEach(()=>fs.rmSync(base,{recursive:true,force:true}));
const initWorktree=()=>{execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial']);const worktree=path.join(base,'legacy-worktree');execFileSync('git',['-C',root,'worktree','add','-qb','test',worktree]);return worktree;};
const sop=(name:string)=>'---\nname: '+name+'\ndescription: fixture metadata\n---\nPRIVATE_SKILL_BODY';

describe('Hermes-compatible recall boundaries',()=>{
 it('resolves relative stores under the agent root and validates custom project directories',()=>{
  put(path.join(home,'.pi/agent/hermes-memory-config.json'),JSON.stringify({memoryDir:'custom-memories',projectsMemoryDir:'custom-projects'}));
  const scope=resolveHermesScope(root,home);
  expect(scope.memoryDir).toBe(path.join(home,'.pi/agent/custom-memories'));expect(scope.projectsRoot).toBe(path.join(home,'.pi/agent/custom-projects'));
  makeHermesDatabase(home,[{content:'Orchid scoped rule',project:'CPA'}],scope.memoryDir);
  expect(new HermesMemoryRetriever(home).retrieve('Orchid',root).memories).toHaveLength(1);
  put(path.join(scope.memoryDir,'skills/global-sop/SKILL.md'),sop('global-sop'));
  put(path.join(scope.projectsRoot,'CPA/skills/project-sop/SKILL.md'),sop('project-sop'));
  put(path.join(scope.projectsRoot,'foreign/skills/foreign-sop/SKILL.md'),sop('foreign-sop'));
  expect(new SkillCollector(home).collectLearnedSkills(root).map(s=>s.name).sort()).toEqual(['global-sop','project-sop']);
  put(path.join(home,'.pi/agent/hermes-memory-config.json'),JSON.stringify({projectsMemoryDir:'../escaped'}));
  expect(resolveHermesScope(root,home).projectsRoot).toBe(path.join(home,'.pi/agent/projects-memory'));
 });
 it('matches the legacy worktree bridge only when the canonical project store is absent',()=>{
  const worktree=initWorktree();const projects=path.join(home,'.pi/agent/projects-memory');
  put(path.join(projects,'legacy-worktree/skills/legacy/SKILL.md'),sop('legacy'));
  makeHermesDatabase(home,[{content:'Orchid canonical rule',project:'CPA'},{content:'Orchid legacy rule',project:'legacy-worktree'},{content:'Orchid FOREIGN_SECRET',project:'foreign'}]);
  expect(resolveHermesScope(worktree,home).project).toBe('legacy-worktree');
  expect(new HermesMemoryRetriever(home).retrieve('Orchid',worktree).memories.map(m=>m.rule)).toEqual(['Orchid legacy rule']);
  put(path.join(projects,'CPA/skills/canonical/SKILL.md'),sop('canonical'));
  expect(resolveHermesScope(worktree,home).project).toBe('CPA');
  expect(new HermesMemoryRetriever(home).retrieve('Orchid',worktree).memories.map(m=>m.rule)).toEqual(['Orchid canonical rule']);
  expect(new SkillCollector(home).collectLearnedSkills(worktree).map(s=>s.name)).toEqual(['canonical']);
 });
 it('home/root are global-only and cannot adopt a same-named project',()=>{
  makeHermesDatabase(home,[{content:'Orchid global rule',target:'memory'},{content:'Orchid fake-home project',project:path.basename(home),target:'memory'}]);
  for(const cwd of [home,path.parse(home).root]){
   const scope=resolveHermesScope(cwd,home);expect(scope.project).toBeNull();expect(hermesRecallRange(scope).scopes).toEqual(['global']);
   const result=new HermesMemoryRetriever(home).retrieve('Orchid',cwd);expect(result.memories.map(m=>m.rule)).toEqual(['Orchid global rule']);expect(result.stats.project).toBeNull();
  }
 });
 it('matches separate git metadata and a repository rooted at home without adopting their directory names',()=>{
  const metadata=path.join(base,'metadata/repo.git');fs.mkdirSync(path.dirname(metadata));
  execFileSync('git',['init','-q','--separate-git-dir',metadata,root]);
  expect(resolveHermesScope(root,home).project).toBe('CPA');
  expect(resolveHermesScope(path.join(root,'src'),home).project).toBe('CPA');
  put(path.join(path.dirname(metadata),'.agents/skills/foreign/SKILL.md'),sop('METADATA_FOREIGN_SKILL'));
  put(path.join(root,'.agents/skills/native/SKILL.md'),sop('native'));
  expect(new SkillCollector(home).collectSkills(root).map(s=>s.name)).toEqual(['native']);
  execFileSync('git',['init','-q',home]);const child=path.join(home,'demo');fs.mkdirSync(child);
  expect(resolveHermesScope(child,home).project).toBe('demo');
 });
 it('expands exact home and backslash home aliases and uses defaults for invalid strict JSON',()=>{
  const file=path.join(home,'.pi/agent/hermes-memory-config.json');
  put(file,JSON.stringify({memoryDir:'~'}));expect(resolveHermesScope(root,home).memoryDir).toBe(home);
  put(file,JSON.stringify({memoryDir:'~\\custom'}));expect(resolveHermesScope(root,home).memoryDir).toBe(path.join(home,'custom'));
  for(const invalid of ['{broken','{"memoryDir":"foreign",}','{/*comment*/"memoryDir":"foreign"}']){
   put(file,invalid);expect(resolveHermesScope(root,home).memoryDir).toBe(path.join(home,'.pi/agent/pi-hermes-memory'));
  }
  put(path.join(root,'.pi/skills/fixture/SKILL.md'),sop('fixture'));
  expect(new SkillCollector(home).collectSkills(root).map(s=>s.name)).toEqual(['fixture']);
 });
 it('trims the host agent-root environment override without touching default stores',()=>{
  const original=process.env.PI_CODING_AGENT_DIR;const custom=path.join(base,'custom-agent');
  try{process.env.PI_CODING_AGENT_DIR=` ${custom} `;expect(resolveHermesScope(root).agentRoot).toBe(custom);}
  finally{if(original===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=original;}
 });
 it('maps project to project-attributed ordinary memory, never to project-attributed failures',()=>{
  const file=makeHermesDatabase(home,[
   {content:'Orchid global fact',target:'memory'},
   {content:'Orchid project fact',target:'memory',project:'CPA'},
   {content:'Orchid project failure',target:'failure',project:'CPA'},
   {content:'Orchid global preference',target:'user'},
   {content:'Orchid foreign fact',target:'memory',project:'other'},
  ]);const before=fs.readFileSync(file);const retriever=new HermesMemoryRetriever(home);
  const project=retriever.retrieve('Orchid',root,{targets:['project']});
  expect(project.memories.map(m=>m.rule)).toEqual(['Orchid project fact']);expect(project.memories[0].sourceTarget).toBe('project');expect(project.stats.eligible).toBe(4);expect(project.stats.searchable).toBe(1);
  expect(retriever.retrieve('Orchid',root,{targets:['failure']}).memories.map(m=>m.rule)).toEqual(['Orchid project failure']);
  expect(retriever.retrieve('Orchid',root,{targets:['user']}).memories.map(m=>m.rule)).toEqual(['Orchid global preference']);
  expect(retriever.retrieve('Orchid',root,{targets:['memory']}).memories).toHaveLength(2);
  expect(retriever.retrieve('Orchid',root,{targets:[]}).memories).toEqual([]);
  expect(JSON.stringify(project)).not.toContain('foreign');expect(fs.readFileSync(file)).toEqual(before);
 });
});
