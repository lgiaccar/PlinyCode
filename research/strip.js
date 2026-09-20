const fs=require('fs');
let s=fs.readFileSync(process.argv[2],'utf8');
s=s.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'').replace(/<svg[\s\S]*?<\/svg>/gi,'');
s=s.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|h[1-6]|tr|pre|td)>/gi,'\n');
s=s.replace(/<[^>]+>/g,' ');
s=s.replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ');
s=s.replace(/[ \t]+/g,' ').replace(/\n[ \t]*(\n[ \t]*)+/g,'\n');
console.log(s);
