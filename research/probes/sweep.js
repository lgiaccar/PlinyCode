const KEY=process.env.PLINY_API_KEY, BASE="https://snps-inference.internal.synopsys.com/api/llm";
const tools=[{type:"function",function:{name:"read_file",description:"Read a file",
 parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}}];
async function probe(model){
 try{
  const r=await fetch(BASE+"/chat/completions",{method:"POST",
   headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},
   body:JSON.stringify({model,messages:[{role:"user",content:"Read src/main.ts with your tool."}],tools,max_tokens:100,stream:false})});
  const j=await r.json();
  if(j.error) return {model,ok:false,st:j.error.code||r.status,msg:(j.error.message||"").slice(0,55)};
  const m=j.choices?.[0]?.message||{};
  return {model,ok:true,tool:!!(m.tool_calls&&m.tool_calls.length),ctx:null};
 }catch(e){return {model,ok:false,st:"EXC",msg:e.message.slice(0,50)};}
}
(async()=>{
 const r=await fetch(BASE+"/models",{headers:{Authorization:"Bearer "+KEY}});
 const all=(await r.json()).data.map(x=>x.id);
 // chat-capable candidates only: skip embedding/rerank/ocr/vision-only by name heuristic
 const skip=/embed|rerank|ocr|tableformer|easyocr|rapidocr|nemotron-parse|doc-fig|codeformula|paddleocr|heron|guard|nemoguard|topic-ctr/i;
 const cands=all.filter(m=>!skip.test(m));
 console.log(`catalog=${all.length} probing=${cands.length}\n`);
 const out=[];
 for(let i=0;i<cands.length;i+=6){
  const batch=cands.slice(i,i+6);
  out.push(...await Promise.all(batch.map(probe)));
  process.stderr.write(".");
 }
 process.stderr.write("\n");
 const okTool=out.filter(x=>x.ok&&x.tool), okNoTool=out.filter(x=>x.ok&&!x.tool), bad=out.filter(x=>!x.ok);
 console.log("=== TOOL-CALLING OK ("+okTool.length+") ===");
 okTool.forEach(x=>console.log("  "+x.model));
 console.log("\n=== RESPONDS, NO TOOL CALL ("+okNoTool.length+") ===");
 okNoTool.forEach(x=>console.log("  "+x.model));
 console.log("\n=== UNAVAILABLE ("+bad.length+") ===");
 bad.forEach(x=>console.log(`  [${x.st}] ${x.model} :: ${x.msg}`));
})();
