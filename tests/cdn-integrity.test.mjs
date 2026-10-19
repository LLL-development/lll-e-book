import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('every external executable script has pinned bytes and cross-origin integrity enforcement',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const tags=html.match(/<script\b[^>]*src="https:\/\/[^" >]+"[^>]*>/g) || [];
 assert.ok(tags.length>0,'external library consumers remain present');
 for(const tag of tags){assert.match(tag,/integrity="sha512-[A-Za-z0-9+/]+=*"/);assert.match(tag,/crossorigin="anonymous"/);}
});
