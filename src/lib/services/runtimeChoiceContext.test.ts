import {describe,it,expect} from "vitest";
import {buildRuntimeChoicePrompt} from "./runtimeChoiceContext";
import {assertContextBudget,CHOICE_CONTEXT_TARGET,LOCAL_CONTEXT_HARD_LIMIT} from "../llm/contextBudget";
function source(act:number,text:string,roleName="甲"):any{return{roleName,actIndex:act,actId:`runtime_act_${act}`,definitionId:"def",sourceRoleActBookletId:`b-${roleName}-${act}`,privateText:text,mustShare:[text],mayShare:[text],mustNotShare:[],emotionalPoints:[],relationshipPoints:[],timelineFragments:[]};}
function fixture():any {const s=source(1,"你曾在旧钟楼被同伴接住，此后愿意信任同伴。");return{role_id:"甲",act_id:"runtime_act_5",private_text:"你叫林舟，曾在旧钟楼失去同伴。你愿意再次相信他吗？若愿意选择同行，否则选择独行。",must_share:[],may_share:[],must_not_share:["不得公开旧口令"],historical_private_knowledge:{original_booklets:[s],summary:[{text:"REPEATED_SUMMARY"}],relevant_original_passages:[],restrictions:[]},roleMemory:{internal_readings:{runtime_act_1:{status:"completed"}}},publicStoryBoard:{known_facts:["同伴说愿意再次结伴。"],current_conflicts:[],emotional_bonds:[],open_questions:["ACCUMULATED-UNRELATED".repeat(5000)]},recentPublicMessages:[{id:"p",speakerRoleId:"乙",content:"我愿意再次结伴去旧钟楼。"}]};}
const choice={prompt:"你愿意和同伴再去旧钟楼吗？",options:[{optionId:"together",label:"同行"},{optionId:"alone",label:"独行"}]};
describe("lightweight decision context",()=>{
 it("keeps the complete current booklet and source-linked relevant history without duplicate summaries or full board",()=>{
  const c=fixture(),p=buildRuntimeChoicePrompt(c,choice);expect(p.payload.ownCurrentAct.privateText).toBe(c.private_text);expect(p.payload.identity.self_name).toBe("林舟");expect(p.payload.historicalMemories[0].text).toContain("接住");expect(JSON.stringify(p)).not.toMatch(/REPEATED_SUMMARY|ACCUMULATED-UNRELATED/);expect(p.metrics.serializedChars).toBeLessThan(CHOICE_CONTEXT_TARGET);
 });
 it("does not repeat annotations already present in the original but keeps additional authored facts",()=>{const c=fixture();c.must_share=[c.private_text];c.may_share=["你另有一张合法入场券。"];const p=buildRuntimeChoicePrompt(c,choice);expect(p.payload.ownCurrentAct.additionalKnownFacts).toEqual(c.may_share);expect(p.payload.ownCurrentAct.mustNotShare).toEqual(c.must_not_share);});
 it.each(["future","other-role","unread"])("excludes %s originals even if included in a malformed archive",reason=>{
  const c=fixture(),s=source(reason==="future"?6:2,"PRIVATE-FORBIDDEN-MARKER",reason==="other-role"?"乙":"甲");c.historical_private_knowledge.original_booklets.push(s);if(reason!=="unread")c.roleMemory.internal_readings[s.actId]={status:"completed"};
  expect(JSON.stringify(buildRuntimeChoicePrompt(c,choice))).not.toContain("PRIVATE-FORBIDDEN-MARKER");
 });
 it("recognizes an authorized display name different from the role ID",()=>{const c=fixture();c.role_id="role-a";c.role_name="甲";expect(buildRuntimeChoicePrompt(c,choice).payload.historicalMemories.length).toBeGreaterThan(0);});
 it("passes both legal choices without changing their meaning or supplying a default",()=>{const p=buildRuntimeChoicePrompt(fixture(),choice);expect(p.payload.choice.options).toEqual(choice.options);expect(p.messages[0].content).toContain("不随机");expect(p.payload).not.toHaveProperty("defaultOptionId");});
 it("fails explicitly instead of cutting a decisive current passage",()=>{const c=fixture();c.private_text="完整的决定性经历。".repeat(8000);expect(()=>buildRuntimeChoicePrompt(c,choice)).toThrow("本地模型上下文超限");expect(c.private_text.endsWith("经历。")).toBe(true);});
 it("measures escaped wire messages with 12000 characters reserved before the hard guard",()=>{
  expect(LOCAL_CONTEXT_HARD_LIMIT-CHOICE_CONTEXT_TARGET).toBe(12000);
  const wire=[{role:"user",content:'"'.repeat(31000)}];expect(()=>assertContextBudget(wire)).toThrow("本地模型上下文超限");
  expect(()=>assertContextBudget([{role:"user",content:"我".repeat(59000)}])).not.toThrow();
 });
});
