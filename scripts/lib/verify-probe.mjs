import {createOneBot} from '../../plugins/_bridge.mjs';
import {decrypt} from './secrets.mjs';
export async function verifyQzone(cfg,{confirmPrivatePostAndDelete=false,call}={}){
 if(confirmPrivatePostAndDelete!==true)throw new Error('须明确允许创建仅自己可见的测试说说并立即删除');
 const client=createOneBot({...cfg.onebot,httpUrl:cfg.onebot?.httpUrl || cfg.snowluma?.httpUrl,accessToken:decrypt(cfg.secrets?.['snowluma-dsh.onebotToken'] || cfg.onebot?.accessToken || cfg.snowluma?.accessToken || ''),timeoutMs:8000});
 const invoke=call || ((a,p)=>client.onebot(a,p));
 await invoke('qzone_list',{count:1});
 const post=await invoke('qzone_post',{content:'插件市场私密功能验证 '+new Date().toISOString(),visibility:'private',images:[]});
 const tid=post?.tid || post?.data?.tid;
 if(!tid) return {ok:false,code:'cleanup_unknown',detail:'协议未返回tid，不能确认清理成功；请在空间检查测试说说。不会自动重发。',at:Date.now()};
 try{await invoke('qzone_delete',{tid:String(tid)});}catch(e){return {ok:false,code:'cleanup_failed',tid:String(tid),detail:'私密测试说说已创建但删除失败，请手动删除：'+e.message,at:Date.now()};}
 return {ok:true,code:'direct_verified',detail:'协议端私密发布并删除验证通过；QQ会话守卫/策略仍需实际会话验证',at:Date.now()};
}
