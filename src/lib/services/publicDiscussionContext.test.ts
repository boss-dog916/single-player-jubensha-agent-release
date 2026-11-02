import {describe,it,expect} from "vitest";
import {publicChoiceContext,currentDMInteraction} from "./publicDiscussionContext";
function fixture(){
 const options=Array.from({length:6},(_,i)=>({optionId:`p${i}`,label:`原文选项${i}`}));
 const node={nodeId:"match",actIndex:2,targetRoleNames:["甲","乙"],choice:{type:"group_matching",choiceId:"choice",round:1,maxRounds:4,prompt:"讨论纸条",options}};
 const session:any={runtimeDefinitionId:"def",currentActId:"runtime_act_2",aiRoleIds:["乙"],dmFlowCursor:{nodeId:"match",actIndex:2,lifecycle:{definitionId:"def",definitionVersion:1},consumedNodeIds:["match"],completedNodeIds:[],groupMatchingReceipts:[{definitionId:"def",definitionVersion:1,choiceId:"choice",nodeId:"match",round:1,assignments:[{roleId:"甲",optionId:"p1"},{roleId:"乙",optionId:"p2"}],correctCount:2,resultStatus:"pending"}]}};
 const view:any={id:"def",version:1,definition:{dmFlow:{actFlows:[{actIndex:2,nodes:[node]}]}}};
 const messages:any[]=[{message_id:"announce",speaker_type:"dm",content:"六张纸条已公开，请讨论。",metadata:{sourceNodeId:"match",act_id:"runtime_act_2",runtimeDefinitionId:"def",runtimeDefinitionVersion:1}}];
 return{session,view,messages,node};
}
describe("public choices have an explicit publication boundary",()=>{
 it("keeps six original labels and public rules without needing the latest chat window",()=>{const f=fixture();expect(publicChoiceContext(f.session,f.view,f.messages,"乙")).toMatchObject({options:f.node.choice.options,publicRules:f.messages[0].content,sourceMessageId:"announce"});});
 it.each(["no-announcement","not-consumed","wrong-definition","wrong-version","outsider","future"])("fails closed for %s",reason=>{
  const f=fixture();let role="乙";if(reason==="no-announcement")f.messages=[];if(reason==="not-consumed")f.session.dmFlowCursor.consumedNodeIds=[];if(reason==="wrong-definition")f.messages[0].metadata.runtimeDefinitionId="other";if(reason==="wrong-version")f.messages[0].metadata.runtimeDefinitionVersion=2;if(reason==="outsider")role="丙";if(reason==="future")f.node.actIndex=3;
  expect(publicChoiceContext(f.session,f.view,f.messages,role)).toBeNull();
 });
 it("requires both a published receipt and its committed result message before showing score",()=>{
  const f=fixture(),r=f.session.dmFlowCursor.groupMatchingReceipts[0];
  expect(publicChoiceContext(f.session,f.view,f.messages,"乙")!.history[0]).not.toHaveProperty("correctCount");
  r.resultStatus="published";expect(publicChoiceContext(f.session,f.view,f.messages,"乙")!.history[0]).not.toHaveProperty("correctCount");
  f.messages.push({message_id:"score",speaker_type:"dm",metadata:{runtimeDefinitionId:"def",runtimeDefinitionVersion:1,groupMatchingResult:true,choiceId:"choice",round:1}});
  expect(publicChoiceContext(f.session,f.view,f.messages,"乙")!.history[0].correctCount).toBe(2);
 });
 it("does not serialize private fields even if accidentally attached to Runtime choice or receipt",()=>{
  const f=fixture();Object.assign(f.node.choice,{GroupMatchingKey:"SECRET",correctAssignments:"SECRET",hint:"PRIVATE-HINT"});Object.assign(f.session.dmFlowCursor.groupMatchingReceipts[0],{privateData:"SECRET"});
  expect(JSON.stringify(publicChoiceContext(f.session,f.view,f.messages,"乙"))).not.toMatch(/SECRET|PRIVATE-HINT/);
 });
});
describe("temporary player follow-ups stay in the current DM thread",()=>{
 function thread(){const f=fixture();f.session.dmFlowCursor={...f.session.dmFlowCursor,nodeId:"dm",textPresentation:{confirmed:false},pendingDMQuestion:{messageId:"dm-q",nodeId:"dm",targetRoleNames:["乙"]}};
 f.messages=[{message_id:"dm-q",speaker_type:"dm",content:"乙，请介绍你记起的现场。",metadata:{act_id:"runtime_act_2",runtimeDefinitionId:"def",sourceNodeId:"dm",textInteraction:true}},{message_id:"ai-a",speaker_type:"ai_player",speaker_role_id:"乙",reply_to_message_id:"dm-q",metadata:{act_id:"runtime_act_2"}}];return f;}
 it("allows a quoted AI response, including a later turn of the same narrow thread",()=>{const f=thread(),q:any={message_id:"user-q",speaker_type:"user",reply_to_message_id:"ai-a",metadata:{act_id:"runtime_act_2"}};expect(currentDMInteraction(f.session,f.messages,q)).toMatchObject({kind:"player_followup",target_role_ids:["乙"],requests_experience:true});f.messages.push(q,{message_id:"ai-a2",speaker_type:"ai_player",speaker_role_id:"乙",reply_to_message_id:"user-q",metadata:{act_id:"runtime_act_2"}});expect(currentDMInteraction(f.session,f.messages,{...q,message_id:"user-q2",reply_to_message_id:"ai-a2"})?.target_role_ids).toEqual(["乙"]);});
 it.each(["confirmed","different-node","no-reply","other-role","cycle"])("does not grant a scope for %s",reason=>{const f=thread(),q:any={message_id:"user-q",speaker_type:"user",reply_to_message_id:"ai-a"};if(reason==="confirmed")f.session.dmFlowCursor.textPresentation.confirmed=true;if(reason==="different-node")f.session.dmFlowCursor.nodeId="elsewhere";if(reason==="no-reply")q.reply_to_message_id=null;if(reason==="other-role")f.messages[1].speaker_role_id="丙";if(reason==="cycle")f.messages[1].reply_to_message_id="ai-a";expect(currentDMInteraction(f.session,f.messages,q)).toBeNull();});
});
