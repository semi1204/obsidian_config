from pathlib import Path
import argparse
import hashlib
import json

HERE = Path(__file__).parent
parser = argparse.ArgumentParser(description="Patch Notebook Navigator 3.2.2 with deferred folder confirmation hooks.")
parser.add_argument("--base", required=True, type=Path, help="Path to the upstream 3.2.2 main.js")
parser.add_argument("--output", required=True, type=Path, help="Output main.js path")
args = parser.parse_args()
source = args.base.expanduser().resolve().read_text()

def replace_once(before, after):
    global source
    assert source.count(before) == 1, f'Expected exactly one target: {before[:80]}'
    source = source.replace(before, after, 1)

replace_once(
    'k=(0,NP.useCallback)(()=>f.selectionType===W.FOLDER&&f.selectedFolder?.path?w(f.selectedFolder.path,W.FOLDER):f.selectionType===W.TAG&&f.selectedTag?w(f.selectedTag,W.TAG):f.selectionType===W.PROPERTY&&f.selectedProperty?w(f.selectedProperty,W.PROPERTY):-1,[f,w])',
    'k=(0,NP.useCallback)(()=>l.app.plugins.plugins["navigator-vim-keys"]?.getNavigationIndex(n.current,t)??(f.selectionType===W.FOLDER&&f.selectedFolder?.path?w(f.selectedFolder.path,W.FOLDER):f.selectionType===W.TAG&&f.selectedTag?w(f.selectedTag,W.TAG):f.selectionType===W.PROPERTY&&f.selectedProperty?w(f.selectedProperty,W.PROPERTY):-1),[f,w,l,n,t])')
replace_once(
    'F=(0,NP.useCallback)(T=>{if(T.type===he.FOLDER)',
    'F=(0,NP.useCallback)((T,confirmed=!1)=>{if(!confirmed&&l.app.plugins.plugins["navigator-vim-keys"]?.previewNavigationItem(n.current,T,()=>F(T,!0)))return;if(T.type===he.FOLDER)')
replace_once('},[h,u,b,v,g]),P=(0,NP.useCallback)', '},[h,u,b,v,g,l,n]),P=(0,NP.useCallback)')
replace_once(
    'E=!_;_&&y.singlePane&&u.autoExpandNavItems?',
    'E=!_&&!l.app.plugins.plugins["navigator-vim-keys"];_&&y.singlePane&&u.autoExpandNavItems?')

output = args.output.expanduser().resolve()
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(source)
(output.parent / 'navigator-build.json').write_text(json.dumps({
    'base': 'Notebook Navigator 3.2.2',
    'patches': 4,
    'sha256': hashlib.sha256(source.encode()).hexdigest(),
}, indent=2))
print('Built the four Notebook Navigator hooks for folder confirmation.')
