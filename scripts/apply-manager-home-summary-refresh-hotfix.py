from pathlib import Path

path = Path('index.html')
text = path.read_text(encoding='utf-8')

old = '''        state.storeList = [link.store];
        if(link.storeId) state.storeIdMap[link.store] = link.storeId;
        await loadStaffHome(state.store, state.myCrewId);'''

new = '''        state.storeList = [link.store];
        if(link.storeId) state.storeIdMap[link.store] = link.storeId;
        try{
          let storeQuery = db.from('stores').select('id,name,lat,lng,manager_dashboard_enabled,business_day_cutoff_hour');
          storeQuery = link.storeId ? storeQuery.eq('id', link.storeId) : storeQuery.eq('name', link.store);
          const { data: storeRow, error: storeError } = await storeQuery.maybeSingle();
          if(storeError) throw storeError;
          if(storeRow){
            state.store = storeRow.name || link.store;
            state.storeList = [state.store];
            state.storeIdMap[state.store] = storeRow.id;
            state.storeLocationMap = state.storeLocationMap || {};
            state.storeLocationMap[state.store] = (storeRow.lat!=null && storeRow.lng!=null) ? { lat:storeRow.lat, lng:storeRow.lng } : null;
            state.storeManagerDashboardMap = state.storeManagerDashboardMap || {};
            state.storeManagerDashboardMap[state.store] = !!storeRow.manager_dashboard_enabled;
            state.storeCutoffMap = state.storeCutoffMap || {};
            state.storeCutoffMap[state.store] = storeRow.business_day_cutoff_hour!=null ? storeRow.business_day_cutoff_hour : DEFAULT_BUSINESS_DAY_CUTOFF_HOUR;
          }
        }catch(e){}
        await loadStaffHome(state.store, state.myCrewId);'''

if text.count(old) != 1:
    raise SystemExit(f'expected exactly one refresh restore anchor, found {text.count(old)}')
text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('manager home summary refresh hotfix applied')
