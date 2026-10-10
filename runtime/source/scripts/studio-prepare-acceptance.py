#!/usr/bin/env python3
"""Prepare the existing five-shot brief in v3 for review. Does not approve or generate."""
import argparse, base64, json, os, pathlib, urllib.request, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(); parser.add_argument('--base',default='http://127.0.0.1:18293/api/v3');args=parser.parse_args()
def api(path,data=None,method=None):
    headers={'Content-Type':'application/json'}
    if os.environ.get('STUDIO_TEST_TOKEN'):headers['Authorization']='Bearer '+os.environ['STUDIO_TEST_TOKEN']
    req=urllib.request.Request(args.base+path,data=json.dumps(data).encode() if data is not None else None,headers=headers,method=method or ('POST' if data is not None else 'GET'))
    with urllib.request.urlopen(req,timeout=120) as res:return json.load(res)['data']
p=api('/projects',{'name':'3.0 验收 · 都市屋顶五镜 · 待确认','demo':True}); pid=p['id'];assets={}
def upload(filename):
    global p
    f=ROOT/'output/fight-script-city'/filename
    r=api(f'/projects/{pid}/assets',{'name':filename,'kind':'image','mime':'image/jpeg','base64':base64.b64encode(f.read_bytes()).decode(),'source':'existing-fight-script-city','metadata':{'provenance':'existing reviewed visual reference; copied without modifying source'}})
    p=r['project'];assets[filename]=r['asset']['id']
for f in ['image-anc-city-identity.jpg','image-anc-luoye-identity.jpg','image-anc-ling-identity.jpg','image-anc-shen-identity.jpg']+[f'image-anc-c{i}.jpg' for i in range(1,6)]:upload(f)
scene=p['scenes'][0];characters=scene['objects'][:3]
for index,(actor,key) in enumerate(zip(characters,['luoye','ling','shen'])):
    p['nodes'].append({'id':str(uuid.uuid4()),'type':'subject','x':index*290,'y':-320,'label':actor['name'],'assetId':assets[f'image-anc-{key}-identity.jpg'],'sceneId':scene['id'],'objectId':actor['id']})
p['nodes'].append({'id':str(uuid.uuid4()),'type':'image','x':870,'y':-320,'label':'现代城市屋顶 · 夜幕初降','assetId':assets['image-anc-city-identity.jpg']})
briefs=[
 ('银丝束缚与踢飞','近中景，低机位轻推。洛夜站稳，手腕柔银丝线已经缠住黑色怪物A；她一次清晰正蹬将怪物踢向画面右后方，银丝随踢击回收，干净收势。动作立即发生并在2.4秒内完成；不新增人物、不换脸。','',0),
 ('鎏金火焰与调侃','中景轻微横移。凌萧燃单手抬起，掌心鎏金火焰形成短距离清晰弹道，命中远处怪物B，金色闪光与黑烟克制。命中后侧头调侃，普通话原句，口型对应。','怎么不再来慢点。',1),
 ('沈月与身份面板','沈月近景缓慢推近，银色光环位于身后，左侧为后期身份面板保留干净留白。她看向队友，以克制不耐烦的口吻说指定普通话原句，口型对应；视频模型不要生成文字。','能不能别摸鱼。',2),
 ('正蹬击退怪物','中全景短促跟随。沈月重心落在支撑腿，对扑来的怪物C作一次清晰正蹬；怪物躯干先受力、向后飞离，轻微尘土与黑雾，无血腥。收腿后轻蔑说指定普通话原句，口型对应。','这点低级恶鬼。',2),
 ('裂隙仍在涌怪','屋顶全景轻微拉远，洛夜、凌萧燃和沈月保持各自站位。远景天空深紫色裂隙继续涌出小型黑色怪物，冲突仍在继续，不关闭裂隙，不突然切黑。','',None)
]
for i,(shot,(title,action,dialogue,subject)) in enumerate(zip(p['shots'],briefs)):
    shot.update(name=f'镜头 {i+1} · {title}',prompt='现代城市屋顶，夜幕初降，写实电影感，真实人物比例、冷暖克制、空间关系连贯。'+action+' 保持首帧人物外形与服装，不要底部字幕，不要文字水印。',dialogue=dialogue,firstAssetId=assets[f'image-anc-c{i+1}.jpg'],subjectIds=[characters[subject]['id']] if subject is not None else [a['id'] for a in characters])
    if i==2:shot['overlay']='沈月\n巳蛇\n能力：银色异能光环'
    for node in p['nodes']:
        if node.get('shotId')==shot['id']:node['label']=shot['name']
p['sequence']['clips']=[{'id':str(uuid.uuid4()),'kind':'text','track':2,'startFrame':116,'endFrame':157,'sourceIn':0,'text':'沈月\n巳蛇\n能力：银色异能光环','volume':1,'fadeIn':0,'fadeOut':0,'x':.23,'y':.43,'fontSize':30,'color':'#eef4ff'}]
p['nodes'].append({'id':str(uuid.uuid4()),'type':'text','x':1160,'y':0,'label':'生成参考条件与验收范围','text':'当前模型链路仅发送每镜首帧和文字提示。人物身份图供脚本核对，骨骼动画及尾帧不是硬控制。生成素材与剪辑时长分开：最终24fps、240帧，五镜区间0–58、58–116、116–162、162–223、223–240。身份文字由后期精确叠加；普通话与口型需逐镜听看验收，失败镜头保留可重生候选。'})
p=api(f'/projects/{pid}',{'baseRevision':p['revision'],'project':p},'PUT')
r=api(f'/projects/{pid}/review')
out=ROOT/'output/studio-v3-validation-20261001/ai-review';out.mkdir(parents=True,exist_ok=True)
notice='<aside style="padding:20px;border:1px solid #8f9ec4;border-radius:12px"><b>3.0 实际生成前确认</b><p>计划逐镜调用现有 Seedance 链路，再按五镜帧区间剪辑为严格10秒。当前只发首帧与文字提示；身份图用于审核，3D骨骼不是硬控制。对白/口型需人工听看验收。身份面板在116–157帧由后期叠加，不做底部字幕。此页仍未确认，尚未提交生成。</p></aside>'
r['html']=r['html'].replace('<h1>',notice+'<h1>',1)
(out/'review.html').write_text(r['html']);(out/'project.json').write_text(json.dumps(p,ensure_ascii=False,indent=2));(out/'review-snapshot.json').write_text(json.dumps({'projectId':pid,'revision':p['revision'],'shots':r['shots']},ensure_ascii=False,indent=2))
print(json.dumps({'projectId':pid,'revision':p['revision'],'review':str(out/'review.html'),'url':args.base.removesuffix('/api/v3')+'/video/studio?project='+pid,'approved':False},ensure_ascii=False))
