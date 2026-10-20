javascript:(function(){
  var keys=['_uid','_d','vc3','vc2','fid','UID','uf','lv'];
  var jar={};
  document.cookie.split(';').forEach(function(c){
    var i=c.indexOf('=');
    if(i<0)return;
    var k=c.slice(0,i).trim(), v=c.slice(i+1).trim();
    if(keys.indexOf(k)!==-1) jar[k]=v;
  });
  var out=Object.keys(jar).map(function(k){return k+'='+jar[k];}).join('; ')+'; ';
  if(!Object.keys(jar).length){
    alert('未找到学习通 cookie。\n\n请确认：\n1. 当前页面是 i.mooc.chaoxing.com 或 mooc1-1.chaoxing.com\n2. 已登录\n3. 不是登录页');
    return;
  }
  copy(out);
  console.log('=== 已复制到剪贴板 ===');
  console.log(out);
  alert('已复制到剪贴板！\n\n找到字段: '+Object.keys(jar).join(', ')+'\n\n长度: '+out.length+' 字符\n\n直接粘贴发给我即可。');
})();
