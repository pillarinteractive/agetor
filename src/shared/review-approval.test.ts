import {test,expect} from 'bun:test';
import {normalizeHandoff,reviewApprovalMatches,reviewRequiresRepair} from './pipeline.ts';
const issue='https://github.com/pillar-interactive/pillar/issues/1314',head='a'.repeat(40);
const approved={schemaVersion:1,status:'done',summary:'Independent review approved; every acceptance criterion checked.',reason:'No unresolved findings.',next:'Finish',reviewApproval:{verdict:'approved' as const,headSha:head,issueUrl:issue,acceptanceComplete:true,findings:[]}};
test('explicit independent approval persists and matches only its exact head and issue acceptance',()=>{
 const h=normalizeHandoff(approved);expect(h.reviewApproval).toEqual(approved.reviewApproval);
 expect(reviewApprovalMatches(h,issue,head)).toBe(true);
 expect(reviewApprovalMatches(h,issue,'b'.repeat(40))).toBe(false);
 expect(reviewApprovalMatches(h,issue.replace('1314','1315'),head)).toBe(false);
 expect(reviewApprovalMatches(normalizeHandoff({...approved,reviewApproval:undefined}),issue,head)).toBe(false);
});
test('changes requested or remaining acceptance/findings outrank a finished turn and claimed approval',()=>{
 for(const input of [
  {...approved,summary:'Changes requested: unresolved correctness blocker R1. Acceptance is incomplete.',reason:'Return all findings to Build'},
  {...approved,reviewApproval:{...approved.reviewApproval,verdict:'changes-requested'}},
  {...approved,reviewApproval:{...approved.reviewApproval,acceptanceComplete:false}},
  {...approved,reviewApproval:{...approved.reviewApproval,findings:['R1 must be repaired']}},
 ]){const h=normalizeHandoff(input);expect(reviewRequiresRepair(h)).toBe(true);expect(reviewApprovalMatches(h,issue,head)).toBe(false);}
});
test('malformed/oversized review records fail closed and never trim findings into an approval',()=>{
 for(const record of [
  {...approved.reviewApproval,headSha:'abc'},
  {...approved.reviewApproval,findings:null},
  {...approved.reviewApproval,findings:['x'.repeat(5000)]},
  {...approved.reviewApproval,acceptanceComplete:'true'},
 ]){const h=normalizeHandoff({...approved,reviewApproval:record});expect(h.reviewApproval).toBeUndefined();expect(reviewApprovalMatches(h,issue,head)).toBe(false);}
 const held=normalizeHandoff({...approved,openQuestions:['Owner permission is still required']});expect(reviewApprovalMatches(held,issue,head)).toBe(false);
});
