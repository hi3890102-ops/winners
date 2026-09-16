from pathlib import Path

path = Path('index.html')
text = path.read_text(encoding='utf-8')

old_query = "const { data, error } = await db.from('crew').select('*, stores(id,name)').eq('join_code', code).maybeSingle();"
new_query = "const { data, error } = await db.from('crew').select('*, stores(id,name,lat,lng,manager_dashboard_enabled,business_day_cutoff_hour)').eq('join_code', code).maybeSingle();"
if text.count(old_query) != 1:
    raise SystemExit(f'expected exactly one legacy join query, found {text.count(old_query)}')
text = text.replace(old_query, new_query, 1)

old_state = """      state.storeIdMap[store] = data.stores.id;\n      localSet(\"my-link\", JSON.stringify({ store, crewId: crewObj.id, storeId: data.stores.id }));"""
new_state = """      state.storeIdMap[store] = data.stores.id;\n      state.storeLocationMap = state.storeLocationMap || {};\n      state.storeLocationMap[store] = (data.stores.lat!=null && data.stores.lng!=null) ? { lat:data.stores.lat, lng:data.stores.lng } : null;\n      state.storeManagerDashboardMap = state.storeManagerDashboardMap || {};\n      state.storeManagerDashboardMap[store] = !!data.stores.manager_dashboard_enabled;\n      state.storeCutoffMap = state.storeCutoffMap || {};\n      state.storeCutoffMap[store] = data.stores.business_day_cutoff_hour!=null ? data.stores.business_day_cutoff_hour : DEFAULT_BUSINESS_DAY_CUTOFF_HOUR;\n      localSet(\"my-link\", JSON.stringify({ store, crewId: crewObj.id, storeId: data.stores.id }));"""
if text.count(old_state) != 1:
    raise SystemExit(f'expected exactly one staff join state anchor, found {text.count(old_state)}')
text = text.replace(old_state, new_state, 1)

path.write_text(text, encoding='utf-8')
print('manager home summary hotfix applied')
