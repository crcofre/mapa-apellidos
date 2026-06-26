# -*- coding: utf-8 -*-
# Genera el PDF del informe de un apellido (3 paginas: regiones/provincias/comunas)
# y escribe pdf_reports/requests/<request_id>.json con el resultado.
# Reemplaza el flujo Playwright. Datos: prevalencia agregada (totalapellido/totalcomuna),
# ajuste Aysen (-0.05 pp, piso 0) en region/provincia, y filtro por lista blanca.
import json,html,base64,io,sys,os,re,unicodedata,argparse,datetime
import cairosvg, fitz
from PIL import Image

ROOT=os.environ.get("REPO_ROOT",".")
DATADIR=os.path.join(ROOT,"data")
ASSETS=os.path.join(ROOT,"pdf_assets")
WHITELIST=os.path.join(ROOT,"apellidos_validos.txt")
OUTDIR=os.path.join(ROOT,"pdf_reports")
REQDIR=os.path.join(OUTDIR,"requests")
RAW="https://raw.githubusercontent.com/CRCOFRE/mapa-apellidos/main/pdf_reports/"
PAGES="https://crcofre.github.io/mapa-apellidos/pdf_reports/"

ap=argparse.ArgumentParser()
ap.add_argument("--surname",required=True)
ap.add_argument("--request_id",default="")
A=ap.parse_args()
REQ=A.request_id or datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S%f")

INK="#261c15";NAVY="#141246";MUT="#6f6457";LINE="#e7ded0";CREAM="#fcfaf5";PARCH="#f4eddf"
PAL=['#e9e7f1','#c2bfdb','#8f8cbe','#4d4a8c','#171545'];SANS="'DM Sans','Helvetica Neue',Arial,sans-serif"
def esc(s):return html.escape(str(s))
def norm(s):
    t=unicodedata.normalize('NFD',str(s or '')).encode('ascii','ignore').decode().upper().strip()
    t=re.sub(r'\s+',' ',t);t=re.sub(r'^\d+\s*[.\-]?\s*','',t)
    t=re.sub(r'^(REGION|PROVINCIA|DEPARTAMENTO)\s+(DEL\s+|DE\s+)?','',t);t=re.sub(r'^(DEL|DE)\s+','',t)
    return t.strip()
def alias(k):return k.replace('AISEN','AYSEN').replace('COIHAIQUE','COYHAIQUE')
def slugify(s):
    t=unicodedata.normalize('NFD',str(s)).encode('ascii','ignore').decode().lower().strip()
    return re.sub(r'[^a-z0-9]+','-',t).strip('-')
ACCN={"sanchez":"Sánchez","gonzalez":"González","munoz":"Muñoz","rojas":"Rojas","diaz":"Díaz","perez":"Pérez","soto":"Soto","contreras":"Contreras","silva":"Silva","martinez":"Martínez","fuentes":"Fuentes","torres":"Torres","flores":"Flores","vargas":"Vargas","reyes":"Reyes","castro":"Castro","lucero":"Lucero","cofre":"Cofré","espinoza":"Espinoza","araya":"Araya","mancilla":"Mancilla","barria":"Barría"}
SHORT={"COQUIMBO":"Coquimbo","NUBLE":"Ñuble","LOS LAGOS":"Los Lagos","TARAPACA":"Tarapacá","MAULE":"Maule","ARICA Y PARINACOTA":"Arica y Parinacota","ANTOFAGASTA":"Antofagasta","LA ARAUCANIA":"La Araucanía","LOS RIOS":"Los Ríos","METROPOLITANA DE SANTIAGO":"Metropolitana","LIBERTADOR GENERAL BERNARDO O'HIGGINS":"O'Higgins","MAGALLANES Y DE LA ANTARTICA CHILENA":"Magallanes","ATACAMA":"Atacama","BIOBIO":"Biobío","AYSEN DEL GENERAL CARLOS IBANEZ DEL CAMPO":"Aysén","VALPARAISO":"Valparaíso"}
AYREG="AYSEN DEL GENERAL CARLOS IBANEZ DEL CAMPO";AYPROV={"AYSEN","CAPITAN PRAT","COYHAIQUE","GENERAL CARRERA"};PEN=0.05

slug=slugify(A.surname)
os.makedirs(REQDIR,exist_ok=True);os.makedirs(OUTDIR,exist_ok=True)
def write_req(status,pdf_file=None):
    j={"request_id":REQ,"status":status,"slug":slug,"surname":A.surname,
       "pdf_file":pdf_file,"pdf_url":(RAW+pdf_file) if pdf_file else None,
       "pdf_url_pages":(PAGES+pdf_file) if pdf_file else None,
       "created_at":datetime.datetime.utcnow().isoformat()+"Z"}
    open(os.path.join(REQDIR,REQ+".json"),"w",encoding="utf-8").write(json.dumps(j,ensure_ascii=False))
    print("REQ:",status,"->",pdf_file)

# ---- lista blanca ----
VALID=set()
if os.path.exists(WHITELIST):
    VALID=set(x.strip() for x in open(WHITELIST,encoding="utf-8") if x.strip())
if VALID and slug not in VALID:
    write_req("not_found");sys.exit(0)

# ---- cargar shard ----
def load_obj(slug):
    fn=os.path.join(DATADIR,"apellidos_"+slug[:2]+".json")
    if os.path.exists(fn):
        o=json.load(open(fn,encoding="utf-8")).get(slug)
        if o:return o
    mf=os.path.join(DATADIR,"apellidos_manifest.json")
    if os.path.exists(mf):
        m=json.load(open(mf,encoding="utf-8"))
        fn2=m.get(slug)
        if fn2 and os.path.exists(os.path.join(DATADIR,fn2)):
            return json.load(open(os.path.join(DATADIR,fn2),encoding="utf-8")).get(slug)
    return None
obj=load_obj(slug)
if not obj:
    write_req("not_found");sys.exit(0)

def build_index(obj):
    aR={};aP={};aC={}
    for r in obj.get("comunas",[]):
        try:ta=float(r.get("totalapellido") or 0)
        except:ta=0.0
        try:tc=float(r.get("totalcomuna") or 0)
        except:tc=0.0
        for key,d in ((alias(norm(r.get("region"))),aR),(alias(norm(r.get("provincia"))),aP),(alias(norm(r.get("comuna"))),aC)):
            if not key:continue
            x=d.setdefault(key,[0.0,0.0]);x[0]+=ta;x[1]+=tc
    pct=lambda x:(x[0]/x[1]*100.0) if x[1]>0 else 0.0
    reg={k:pct(v) for k,v in aR.items()};prov={k:pct(v) for k,v in aP.items()};com={k:pct(v) for k,v in aC.items()}
    if AYREG in reg:reg[AYREG]=max(0.0,reg[AYREG]-PEN)
    for pk in AYPROV:
        if pk in prov:prov[pk]=max(0.0,prov[pk]-PEN)
    return reg,prov,com
REGV,PROVV,COMV=build_index(obj)
LABEL=ACCN.get(slug,(obj.get("apellido") or A.surname).upper().replace('-',' '))
REG=json.load(open(os.path.join(ASSETS,"lvl_region.json")))["feats"]
PROV=json.load(open(os.path.join(ASSETS,"lvl_provincia.json")))["feats"]
COM=json.load(open(os.path.join(ASSETS,"lvl_comuna.json")))["feats"]

def quant(vals):
    vs=sorted(v for v in vals if v is not None)
    if not vs:return [0,0,0,0]
    def q(p):return vs[min(len(vs)-1,int(p*len(vs)))]
    return [q(.2),q(.4),q(.6),q(.8)]
def ramp(v,thr):
    if v is None:return PAL[0]
    for i in range(4):
        if v<thr[i]:return PAL[i]
    return PAL[4]
def one(v):return round(100.0/v) if v and v>0 else "—"
lo=Image.open(os.path.join(ASSETS,"Logo1.png")).convert("RGBA");lo.thumbnail((150,150))
bf=io.BytesIO();lo.save(bf,"PNG");LOGO="data:image/png;base64,"+base64.b64encode(bf.getvalue()).decode()
def logo(x,y,h):
    w=h*lo.width/lo.height
    return (f'<image href="{LOGO}" x="{x}" y="{y}" width="{w:.0f}" height="{h}"/>'
            f'<text x="{x+w+11:.0f}" y="{y+h*0.62:.0f}" font-size="{h*0.42:.0f}" fill="{INK}" font-family="{SANS}" font-weight="700">Familias y Apellidos</text>')
Wd,Ht=794,1123
def split_map(feats,valdict,thr,x0,y0,totalW,H,gap=18,splitY=455,markn=5):
    def rv(f):return valdict.get(f["k"])
    north=[f for f in feats if f["cy"]<splitY];south=[f for f in feats if f["cy"]>=splitY]
    def bb(fs):return [min(f["bb"][0] for f in fs),min(f["bb"][1] for f in fs),max(f["bb"][2] for f in fs),max(f["bb"][3] for f in fs)]
    nb=bb(north);sb=bb(south);bwn=nb[2]-nb[0];bhn=nb[3]-nb[1];bws=sb[2]-sb[0];bhs=sb[3]-sb[1]
    sc=min(H/max(bhn,bhs),(totalW-gap)/(bwn+bws));usedW=(bwn+bws)*sc+gap;sx0=x0+(totalW-usedW)/2
    out=[];TR={}
    def draw(fs,b,sx,side):
        bh=b[3]-b[1];ox=sx-b[0]*sc;oy=y0+(H-bh*sc)/2-b[1]*sc;TR[side]=(ox,oy)
        out.append(f'<g transform="translate({ox:.2f} {oy:.2f}) scale({sc:.4f})">')
        for f in fs:out.append(f'<path d="{f["d"]}" fill="{ramp(rv(f),thr)}" stroke="#1c1a4d" stroke-width="{0.45/sc:.3f}"/>')
        out.append('</g>')
    draw(north,nb,sx0,'n');draw(south,sb,sx0+bwn*sc+gap,'s')
    nk=set(f["k"] for f in north)
    top=sorted([f for f in feats if rv(f) is not None],key=lambda f:-rv(f))[:markn]
    for i,f in enumerate(top,1):
        side='n' if f["k"] in nk else 's';ox,oy=TR[side];sx=ox+f["cx"]*sc;sy=oy+f["cy"]*sc
        r=8 if markn>5 else 9;fz=10 if markn>5 else 11
        out.append(f'<circle cx="{sx:.1f}" cy="{sy:.1f}" r="{r}" fill="{NAVY}" stroke="#fff" stroke-width="1.5"/><text x="{sx:.1f}" y="{sy+3.2:.1f}" text-anchor="middle" font-size="{fz}" fill="#fff" font-family="{SANS}" font-weight="700">{i}</text>')
    return "\n".join(out),top
def picon(name,x,y):
    if name=="dip":return f'<circle cx="{x+13}" cy="{y+11}" r="6" fill="none" stroke="{NAVY}" stroke-width="2"/><path d="M{x+10} {y+16} L{x+9} {y+24} L{x+13} {y+21.5} L{x+17} {y+24} L{x+16} {y+16}" fill="none" stroke="{NAVY}" stroke-width="2" stroke-linejoin="round"/>'
    if name=="arb":return f'<rect x="{x+9}" y="{y+2}" width="8" height="6" rx="1.5" fill="none" stroke="{NAVY}" stroke-width="2"/><rect x="{x+2}" y="{y+18}" width="8" height="6" rx="1.5" fill="none" stroke="{NAVY}" stroke-width="2"/><rect x="{x+16}" y="{y+18}" width="8" height="6" rx="1.5" fill="none" stroke="{NAVY}" stroke-width="2"/><path d="M{x+13} {y+8} V{y+12} M{x+6} {y+18} V{y+12} H{x+20} V{y+18}" fill="none" stroke="{NAVY}" stroke-width="2"/>'
    return f'<rect x="{x+4}" y="{y+3}" width="12" height="16" rx="2" fill="none" stroke="{NAVY}" stroke-width="2"/><circle cx="{x+16}" cy="{y+15}" r="4.5" fill="{CREAM}" stroke="{NAVY}" stroke-width="2"/><line x1="{x+19}" y1="{y+18}" x2="{x+23}" y2="{y+22}" stroke="{NAVY}" stroke-width="2"/>'
PRODS=[("dip","Diploma del Apellido","El origen e historia de tu apellido.","https://www.apellidos.cl/diploma"),
       ("arb","Árbol Genealógico","Tu familia, hasta 5 generaciones.","https://www.apellidos.cl/arbol-genealogico"),
       ("inv","Investigación Genealógica","Rastreamos a tus ancestros.","https://www.apellidos.cl/investigacion-genealogica")]
def products(S,links,py):
    S.append(f'<line x1="50" y1="{py-16}" x2="{Wd-50}" y2="{py-16}" stroke="{LINE}"/>')
    S.append(f'<text x="50" y="{py+6}" font-size="15" fill="{INK}" font-family="{SANS}" font-weight="700">Lleva la historia de tu familia más allá del mapa</text>')
    cw=(Wd-100-2*16)/3
    for i,(ic,t,d,url) in enumerate(PRODS):
        x=50+i*(cw+16);cyy=py+22
        links.append((x,cyy,x+cw,cyy+112,url))
        S.append(f'<a xlink:href="{url}">')
        S.append(f'<rect x="{x}" y="{cyy}" width="{cw}" height="112" rx="12" fill="#fff" stroke="{LINE}"/>')
        S.append(f'<rect x="{x+16}" y="{cyy+16}" width="32" height="32" rx="8" fill="#f0eef8"/>')
        S.append(picon(ic,x+16+4,cyy+16+4))
        S.append(f'<text x="{x+16}" y="{cyy+72}" font-size="13" fill="{INK}" font-family="{SANS}" font-weight="700">{esc(t)}</text>')
        S.append(f'<text x="{x+16}" y="{cyy+90}" font-size="10.3" fill="{MUT}" font-family="{SANS}">{esc(d)}</text>')
        S.append(f'<text x="{x+16}" y="{cyy+108}" font-size="12" fill="{NAVY}" font-family="{SANS}" font-weight="700">Ver más →</text>')
        S.append('</a>')
def head(S,pg,total):
    S.append(f'<rect width="{Wd}" height="{Ht}" fill="{CREAM}"/><rect x="22" y="22" width="{Wd-44}" height="{Ht-44}" fill="none" stroke="{LINE}" stroke-width="1.4"/>')
    S.append('<a xlink:href="https://www.apellidos.cl">'+logo(50,40,32)+'</a>')
    S.append(f'<text x="{Wd-50}" y="60" text-anchor="end" font-size="10.5" letter-spacing="1.2" fill="{MUT}" font-family="{SANS}">INFORME DEL APELLIDO · pág. {pg}/{total}</text>')
    S.append(f'<line x1="50" y1="88" x2="{Wd-50}" y2="88" stroke="{LINE}"/>')
nreg=len([1 for v in REGV.values() if v is not None]);nprov=len([1 for v in PROVV.values() if v is not None]);ncom=len([1 for v in COMV.values() if v is not None])
LEVELS={
 "region":   dict(feats=REG, vals=REGV, topn=5,  title="Regiones", kicker="POR REGIÓN",   nm=lambda f:SHORT.get(f["k"],f["nm"]), nn=nreg,  unit="regiones"),
 "provincia":dict(feats=PROV,vals=PROVV,topn=10, title="Provincias",kicker="POR PROVINCIA",nm=lambda f:f["nm"], nn=nprov, unit="provincias"),
 "comuna":   dict(feats=COM, vals=COMV, topn=10, title="Comunas",   kicker="POR COMUNA",   nm=lambda f:f["nm"], nn=ncom,  unit="comunas"),
}
ORDER=["region","provincia","comuna"]
def page(level,pg,total):
    C=LEVELS[level];feats=C["feats"];vals=C["vals"];topn=C["topn"];nmf=C["nm"]
    links=[];S=[f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {Wd} {Ht}">']
    head(S,pg,total)
    S.append(f'<text x="50" y="134" font-size="12.5" letter-spacing="4" fill="{MUT}" font-family="{SANS}">{C["kicker"]}</text>')
    S.append(f'<text x="48" y="184" font-size="46" fill="{INK}" font-family="{SANS}" font-weight="700">{esc(LABEL)}</text>')
    S.append(f'<text x="50" y="214" font-size="14" fill="{NAVY}" font-family="{SANS}">{esc(C["title"])} donde más se concentra tu apellido.</text>')
    thr=quant([vals.get(f["k"]) for f in feats])
    mp,top=split_map(feats,vals,thr,52,244,330,566,markn=topn)
    S.append(mp)
    S.append(f'<text x="95" y="822" font-size="11" fill="{MUT}" font-family="{SANS}">Norte</text><text x="270" y="822" font-size="11" fill="{MUT}" font-family="{SANS}">Sur</text>')
    rx=410
    if top:
        t0=top[0]
        S.append(f'<text x="{rx}" y="270" font-size="13.5" fill="{MUT}" font-family="{SANS}">El lugar más {esc(LABEL)}</text>')
        S.append(f'<text x="{rx}" y="312" font-size="32" fill="{NAVY}" font-family="{SANS}" font-weight="700">1 de cada {one(vals.get(t0["k"]))}</text>')
        S.append(f'<text x="{rx}" y="333" font-size="12" fill="{INK}" font-family="{SANS}">personas en {esc(nmf(t0))} lleva tu apellido.</text>')
    S.append(f'<line x1="{rx}" y1="354" x2="{Wd-50}" y2="354" stroke="{LINE}"/>')
    S.append(f'<text x="{rx}" y="382" font-size="14" fill="{INK}" font-family="{SANS}" font-weight="700">{esc(C["title"])} con más {esc(LABEL)}</text>')
    yy=408;step=23.5 if topn>5 else 26
    for i,f in enumerate(top,1):
        S.append(f'<circle cx="{rx+7}" cy="{yy-4}" r="8" fill="{NAVY}"/><text x="{rx+7}" y="{yy-0.7}" text-anchor="middle" font-size="10" fill="#fff" font-family="{SANS}" font-weight="700">{i}</text>')
        S.append(f'<text x="{rx+24}" y="{yy}" font-size="12.5" fill="{INK}" font-family="{SANS}">{esc(nmf(f))}</text>')
        S.append(f'<text x="{Wd-50}" y="{yy}" text-anchor="end" font-size="12" fill="{NAVY}" font-family="{SANS}" font-weight="700">1 de {one(vals.get(f["k"]))}</text>')
        yy+=step
    by=yy+8;bh=96
    S.append(f'<rect x="402" y="{by}" width="{Wd-50-402}" height="{bh}" rx="12" fill="{PARCH}"/>')
    S.append(f'<text x="422" y="{by+28}" font-size="14" fill="{INK}" font-family="{SANS}" font-weight="700">¿Sabías que…?</text>')
    if top:
        cu=[f"En {nmf(top[0])}, 1 de cada {one(vals.get(top[0]['k']))} personas lleva",f"el apellido {LABEL}.",f"Tu apellido aparece en {C['nn']} {C['unit']} del país."]
    else:cu=["Sin datos suficientes."]
    for i,l in enumerate(cu):S.append(f'<text x="422" y="{by+52+i*18}" font-size="11.5" fill="{INK}" font-family="{SANS}">{esc(l)}</text>')
    products(S,links,866)
    S.append(f'<a xlink:href="https://www.apellidos.cl/mapa-de-apellidos"><text x="50" y="1066" font-size="9.5" fill="{NAVY}" font-family="{SANS}" font-weight="700">apellidos.cl/mapa-de-apellidos</text></a>')
    S.append(f'<text x="208" y="1066" font-size="9.5" fill="{MUT}" font-family="{SANS}">· Tonos más oscuros = mayor frecuencia relativa · pág. {pg}/{total}</text>')
    S.append('</svg>')
    links.append((50,40,210,74,"https://www.apellidos.cl"))
    links.append((50,1057,205,1070,"https://www.apellidos.cl/mapa-de-apellidos"))
    return "\n".join(S),links
doc=fitz.open()
for i,lv in enumerate(ORDER,1):
    svg,links=page(lv,i,len(ORDER))
    src=fitz.open("pdf",cairosvg.svg2pdf(bytestring=svg.encode()));doc.insert_pdf(src);src.close()
    pgp=doc[-1];sx=pgp.rect.width/Wd;sy=pgp.rect.height/Ht
    for (x0,y0,x1,y1,url) in links:pgp.insert_link({"kind":fitz.LINK_URI,"from":fitz.Rect(x0*sx,y0*sy,x1*sx,y1*sy),"uri":url})
outpath=os.path.join(OUTDIR,slug+".pdf")
tmp="/tmp/_genpdf.pdf"
if os.path.exists(tmp):os.remove(tmp)
doc.save(tmp);doc.close()
import shutil;shutil.copyfile(tmp,outpath)
write_req("ok",slug+".pdf")
print("OK pdf:",outpath)
