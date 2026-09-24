import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
test('additive vendor schema preserves historical rows and rejects invalid categories',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role authenticated;create table vendors(id int primary key,store_id int,name text);create table expense_entries(id int,amount int,category text);insert into vendors values(1,10,'A'),(2,20,'B');insert into expense_entries values(1,100,null),(2,50,'other');alter table vendors enable row level security;grant select,update on vendors to authenticated;create policy store_scope on vendors to authenticated using(store_id=current_setting('app.store')::int) with check(store_id=current_setting('app.store')::int);`);
 const before=JSON.stringify((await db.query('select * from expense_entries order by id')).rows);
 await db.exec(readFileSync(new URL('../docs/vendor-default-category.sql',import.meta.url),'utf8'));
 assert.deepEqual((await db.query('select default_category from vendors order by id')).rows,[{default_category:null},{default_category:null}]);
 await assert.rejects(db.exec("update vendors set default_category='invalid' where id=1"));
 await db.exec("set app.store='10';set role authenticated;update vendors set default_category='food' where id=1;update vendors set default_category='other' where id=2;");
 assert.equal((await db.query('select * from vendors')).rows.length,1);
 await db.exec('reset role');
 assert.deepEqual((await db.query('select default_category from vendors order by id')).rows,[{default_category:'food'},{default_category:null}]);
 assert.equal(JSON.stringify((await db.query('select * from expense_entries order by id')).rows),before);
 }finally{await db.close();}
});
