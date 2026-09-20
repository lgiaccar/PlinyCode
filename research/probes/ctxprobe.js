const KEY=process.env.PLINY_API_KEY, BASE="https://snps-inference.internal.synopsys.com/api/llm";
async function probe(model){
 try{
  const r=await fetch(BASE+"/chat/completions",{method:"POST",
   headers:{Authorization:"Bearer "+KEY,"Content-Type":"application/json"},
   body:JSON.stringify({model,messages:[{role:"user",content:"hi"}],max_tokens:99999999,stream:false})});
  const j=await r.json();
  const msg=j.error?.message||"";
  const m=msg.match(/max_total_tokens=(\d+)/i)||msg.match(/max_model_len=(\d+)/i)
        ||msg.match(/maximum context length is (\d+)/i)||msg.match(/less than or equal to (\d+)/i)
        ||msg.match(/maximum value[^\d]*(\d{3,})/i);
  return {model, ctx:m?+m[1]:null, ok:!j.error, msg:msg.slice(0,80)};
 }catch(e){return {model,ctx:null,msg:"EXC "+e.message.slice(0,40)};}
}
(async()=>{
 const models=require('fs').readFileSync(process.argv[2],'utf8').trim().split('\n').map(s=>s.trim()).filter(Boolean);
 const out=[];
 for(let i=0;i<models.length;i+=5){
  out.push(...await Promise.all(models.slice(i,i+5).map(probe)));
  process.stderr.write(".");
 }
 process.stderr.write("\n");
 out.sort((a,b)=>(b.ctx||0)-(a.ctx||0));
 for(const x of out) console.log(`${String(x.ctx||"?").padStart(8)}  ${x.model}${x.ctx?"":"   | "+x.msg}`);
})();
