const https=require("https");
const fs=require("fs");
const BASE="https://campus.mciwl.com/api";
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) MicroMessenger/8.0";
function get(p){return new Promise(r=>{const q=https.get(BASE+p,{headers:{"User-Agent":UA},timeout:25000},res=>{let s="";res.on("data",d=>s+=d);res.on("end",()=>{try{r(JSON.parse(s));}catch(e){r(null);}});});q.on("error",()=>r(null));q.on("timeout",()=>{q.destroy();r(null);});});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
// 1. 拿全部学校（不限分页上限）
let schools=[];
for(let page=1;page<=60;page++){
  const j=await get(`/school/list?page=${page}&limit=100`);
  if(!j||!j.data||!j.data.length)break;
  schools.push(...j.data);
  await sleep(120);
}
console.log(`学校总数: ${schools.length}`);

// 2. 只挑有学生的（这些才有题库）
const hot=schools.filter(s=>s.student_count>0).sort((a,b)=>b.student_count-a.student_count);
console.log(`有学生的学校: ${hot.length}`);

// 3. 逐个拉科目
const out={};let total=0;let ok=0;
for(const sc of hot){
  const tree=await get(`/exam/subject-tree?school_id=${sc.id}`);
  if(!tree||!tree.data||!tree.data.length){await sleep(80);continue;}
  let scCount=0;
  for(const g of tree.data){
    for(const sub of (g.subjects||[])){
      if(!sub.question_count||sub.question_count<=0)continue;
      const qs=[];
      for(let page=1;page<=Math.ceil(sub.question_count/50)+2;page++){
        const j=await get(`/exam/question-list?school_id=${sc.id}&subject_id=${sub.id}&bank_type=1&page=${page}&limit=50`);
        if(!j||!j.data||!j.data.length)break;
        qs.push(...j.data);
        if(j.data.length<50)break;
        await sleep(100);
      }
      if(!qs.length)continue;
      const k=`${sc.name} / ${sub.name}`;
      out[k]=qs;total+=qs.length;scCount+=qs.length;
    }
  }
  if(scCount>0){ok++;console.log(`  ✔ ${sc.name}: ${scCount} 题`);}
  await sleep(80);
}

fs.mkdirSync("./tkbank",{recursive:true});
fs.writeFileSync("./tkbank/raw.json",JSON.stringify(out,null,2));
console.log(`\n=== 完成 ===`);
console.log(`  有题库的学校: ${ok}`);
console.log(`  科目组: ${Object.keys(out).length}`);
console.log(`  题目总数: ${total}`);
})().catch(e=>console.error(e.stack));
