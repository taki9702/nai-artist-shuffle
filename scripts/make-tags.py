# 단부루 태그 CSV(danbooru_tag_csv_v2.zip을 푼 폴더)에서 상황 뽑기 자동완성용 web/data/tags.json을 만든다.
# 사용: python3 scripts/make-tags.py <CSV 폴더> web/data/tags.json
# 항목: [태그, 한글명, V5게시물, 종류, 검색키워드, 바꿔쓸태그]
#   종류: 0 일반 1 작가 3 작품 4 캐릭터 5 메타 6 사라진·바뀐
import csv, glob, json, os, sys

src, out = sys.argv[1], sys.argv[2]
def rows(pattern):
    for f in sorted(glob.glob(os.path.join(src, pattern))):
        with open(f, encoding='utf-8-sig') as fh:
            yield from csv.DictReader(fh)

def n(v):
    try: return int(v or 0)
    except ValueError: return 0

items, seen = [], set()
def add(tag, kor, count, kind, kw='', alt=''):
    tag = (tag or '').strip()
    if not tag or tag in seen: return
    seen.add(tag)
    kw = ', '.join(k.strip() for k in (kw or '').split(',') if k.strip() and k.strip() != kor)[:80]
    items.append([tag, (kor or '').strip() if (kor or '').strip() != tag else '', count, kind, kw, alt])

for r in rows('검색통합_전체.csv'):
    kind = {'일반': 0, '메타': 5, 'V5신규': 0, '사라진·바뀐': 6}.get(r['종류'], 0)
    if kind == 6 and not r['바꿔쓸태그'] and r['상태'] == '200 미만으로 감소': kind = 0
    add(r['태그'], r['한글명'], n(r['V5게시물']) or n(r['V4게시물']), kind, r['검색키워드'], r['바꿔쓸태그'] if kind == 6 else '')
for r in rows('작가_*.csv'): add(r['태그'], r['한글명'], n(r['V5게시물']), 1)
for r in rows('작품_*.csv'): add(r['태그'], r['한글명'], n(r['V5게시물']), 3)
for r in rows('캐릭터_*.csv'): add(r['태그'], r['한글명'], n(r['V5게시물']), 4)
items.sort(key=lambda x: -x[2])
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(items, fh, ensure_ascii=False, separators=(',', ':'))
print(len(items), 'tags', os.path.getsize(out) // 1024, 'KB')
