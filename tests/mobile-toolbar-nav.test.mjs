import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../css/style.css',import.meta.url),'utf8');

test('top prev/next toolbar group is marked with .toolbar-nav',()=>{
  const group=html.match(/<div class="toolbar-group toolbar-nav">[\s\S]*?<\/div>/);
  assert.ok(group,'.toolbar-group.toolbar-nav container exists');
  assert.match(group[0],/<button id="prev-btn"/,'group contains #prev-btn');
  assert.match(group[0],/id="next-btn"/,'group contains #next-btn');
});

test('.toolbar-nav is visible by default (desktop, outside any media query)',()=>{
  // base rule must live outside @media blocks: check it appears before "Responsive" section
  const mqStart=css.indexOf('@media (max-width: 640px) {'); // actual rule, not the comment mention
  assert.ok(mqStart>0,'mobile media query exists');
  const base=css.slice(0,mqStart);
  const baseRule=base.match(/\.toolbar-nav\s*\{[^}]*\}/);
  assert.ok(baseRule,'base .toolbar-nav rule exists outside the mobile media query');
  assert.doesNotMatch(baseRule[0],/display:\s*none/,'base rule does not hide the group');
});

test('.toolbar-nav is hidden only inside @media (max-width: 640px)',()=>{
  const start=css.indexOf('@media (max-width: 640px) {');
  assert.ok(start>0);
  // extract the balanced block for this media query
  let depth=0,end=-1;
  for(let i=css.indexOf('{',start);i<css.length;i++){
    if(css[i]==='{')depth++;
    else if(css[i]==='}'){depth--;if(depth===0){end=i;break;}}
  }
  assert.ok(end>start,'media block is closed');
  const block=css.slice(start,end);
  const rule=block.match(/\.toolbar-nav\s*\{[^}]*\}/);
  assert.ok(rule,'.toolbar-nav hide rule exists inside the mobile media query');
  assert.match(rule[0],/display:\s*none/,'group is hidden on mobile');
});

test('no other media query hides .toolbar-nav',()=>{
  const matches=[...css.matchAll(/@media[^{]+\{/g)];
  for(const m of matches){
    let depth=1,i=m.index+m[0].length,end=-1;
    while(i<css.length&&depth>0){
      if(css[i]==='{')depth++;
      else if(css[i]==='}')depth--;
      i++;
    }
    end=i;
    const block=css.slice(m.index,end);
    if(!block.includes('.toolbar-nav'))continue;
    assert.match(m[0],/max-width:\s*640px/,`only the 640px query may hide .toolbar-nav (found: ${m[0].trim()})`);
  }
});

test('bottom mobile bar (#prev-btn-bottom/#next-btn-bottom) remains untouched',()=>{
  assert.match(html,/id="prev-btn-bottom"/);
  assert.match(html,/id="next-btn-bottom"/);
});
