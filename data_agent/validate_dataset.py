# Validazione dataset sintetico TrialPulse

from generate_dataset import generate_dataset, plausibility_config
clean, dirty = generate_dataset()
assert len(clean) == 1500
assert len(dirty) == 1508
assert clean.shape[1] == 43
assert clean['record_id'].is_unique
assert dirty.duplicated().sum() == 8
critical = ['record_id', 'study_id', 'site_id', 'participant_id']
assert dirty[critical].notna().all().all()
eligible = clean.query("screening_failure == False and visit_name != 'Screening' and visit_status != 'not_expected_after_dropout'")
missed = eligible.assign(missed=eligible['visit_status'].eq('missed')).groupby('site_id')['missed'].mean()
query_aging = clean[clean['data_queries_open'] > 0].groupby('site_id')['oldest_open_query_days'].mean()
assert missed.idxmax() == 'SITE_07' and missed['SITE_07'] >= 0.12
assert query_aging.idxmax() == 'SITE_05' and query_aging['SITE_05'] > 10
psi_docs = clean.query("study_id == 'NNR-PSI-01' and site_id == 'SITE_01' and visit_name == 'Dosing Day'")
esk_monitoring = clean.query("study_id == 'NNR-ESK-02' and site_id == 'SITE_06'").dropna(subset=['required_monitoring_complete'])
assert psi_docs['session_documentation_complete'].eq(False).any()
assert esk_monitoring['required_monitoring_complete'].eq(False).mean() >= 0.1
for study_id, cfg in plausibility_config['efficacy'].items():
    endpoint = clean[(clean['study_id'] == study_id) & clean['visit_name'].eq(cfg['endpoint_visit']) & clean['visit_status'].eq('completed') & clean['depression_score'].notna()]
    assert not endpoint.empty
    assert endpoint['depression_score'].between(cfg['score_range']['min'], cfg['score_range']['max']).all()
    remission = endpoint['clinical_remission'].astype(bool).mean()
    rem_cfg = cfg['remission_rate']
    assert rem_cfg['min'] <= remission <= rem_cfg['max']
    if 'response_rate' in cfg:
        response = endpoint['clinical_response'].astype(bool).mean()
        resp_cfg = cfg['response_rate']
        assert resp_cfg['min'] <= response <= resp_cfg['max']
    if 'endpoint_change_mean' in cfg:
        value = endpoint['depression_change_from_baseline'].mean()
        limits = cfg['endpoint_change_mean']
        assert limits['min'] <= value <= limits['max']
    if 'endpoint_score_mean' in cfg:
        value = endpoint['depression_score'].mean()
        limits = cfg['endpoint_score_mean']
        assert limits['min'] <= value <= limits['max']
for study_id, cfg in plausibility_config['safety'].items():
    participants = clean[(clean['study_id'] == study_id) & ~clean['screening_failure']].groupby('participant_id')[['adverse_event', 'serious_adverse_event', 'ae_leading_to_discontinuation']].max()
    for column, key in [('adverse_event', 'any_adverse_event_rate'), ('serious_adverse_event', 'serious_adverse_event_rate'), ('ae_leading_to_discontinuation', 'ae_discontinuation_rate')]:
        rate = participants[column].mean()
        limits = cfg[key]
        assert limits['min'] <= rate <= limits['max']
print('Validazione dataset superata.')
print('Righe clean:', len(clean), '| Righe dirty:', len(dirty), '| Colonne:', clean.shape[1])
print('Duplicati intenzionali:', dirty.duplicated().sum())
print('Più missed:', missed.idxmax(), '| Più query aging:', query_aging.idxmax())
