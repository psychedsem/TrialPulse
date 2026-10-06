from pathlib import Path
import csv
import re
import yaml

ROOT = Path(__file__).resolve().parents[1]
KB = ROOT / "knowledge_base"

EXPECTED = [
    "00_scope.md",
    "protocols/NNR-PSI-01.md",
    "protocols/NNR-ESK-02.md",
    "protocols/NNR-DXB-03.md",
    "protocols/NNR-SER-04.md",
    "reference/visit_schedule_windows.md",
    "operations/clinical_operations_sop.md",
    "operations/deviation_escalation_rules.md",
    "operations/site_monitoring_guidelines.md",
    "operations/roles_responsibilities.md",
    "faq.md",
]

for relative in EXPECTED:
    path = KB / relative
    assert path.exists(), f"File mancante: {relative}"
    assert path.read_text(encoding="utf-8").strip(), f"File vuoto: {relative}"

manifest = yaml.safe_load((KB / "manifest.yaml").read_text(encoding="utf-8"))
ingest = set(manifest["ingest"])
expected_ingest = {f"knowledge_base/{relative}" for relative in EXPECTED}
assert ingest == expected_ingest, "Ingest diverso dai soli 11 documenti operativi previsti"
assert len(manifest["ingest"]) == len(ingest), "Documenti duplicati nell'ingest"
assert not ingest.intersection(manifest["exclude"]), "Un documento è sia ingest sia exclude"

for relative in EXPECTED:
    assert f"knowledge_base/{relative}" in ingest, f"Manifest incompleto: {relative}"

schedule = (KB / "reference/visit_schedule_windows.md").read_text(encoding="utf-8")
design = yaml.safe_load((ROOT / "data_agent/config/study_design.yaml").read_text(encoding="utf-8"))
assert set(design["studies"]) == set(design["schedule"]), "Study ID incoerenti nella configurazione"
for study, window in {
    "NNR-PSI-01": "±4 giorni",
    "NNR-ESK-02": "±2 giorni",
    "NNR-DXB-03": "±4 giorni",
    "NNR-SER-04": "±5 giorni",
}.items():
    section = schedule.split(f"## {study}", 1)[1].split("## ", 1)[0]
    rows = []
    for line in section.splitlines():
        if line.startswith("|"):
            cells = [cell.strip().replace("**", "") for cell in line.strip("|").split("|")]
            if len(cells) == 3 and re.fullmatch(r"[+-]?\d+", cells[1]):
                rows.append((cells[0], int(cells[1]), cells[2]))
    expected_rows = [(visit["name"], visit["target_day"]) for visit in design["schedule"][study]
                     if visit["name"] != "Screening"]
    assert [(name, day) for name, day, _ in rows] == expected_rows, f"Schedule incoerente: {study}"
    assert next(value for name, _, value in rows if name == "Week 6") == window, f"Week 6 incoerente: {study}"
    synopsis = (KB / f"protocols/{study}.md").read_text(encoding="utf-8")
    visits = [line[2:] for line in synopsis.splitlines() if line.startswith("- ")]
    expected_visits = ["Screening"] + [f"{name} - Day {day:+d}" if day else f"{name} - Day 0"
                                      for name, day in expected_rows]
    assert visits == expected_visits, f"Synopsis incoerente con la configurazione: {study}"

with (ROOT / "data/trialpulse_operations.csv").open(encoding="utf-8", newline="") as stream:
    columns = set(next(csv.reader(stream)))
required_columns = {
    "study_id", "site_id", "participant_id", "visit_name", "visit_sequence", "visit_status",
    "target_day", "target_date", "actual_date", "enrollment_date", "required_assessments",
    "missing_assessments", "data_queries_open", "oldest_open_query_days", "protocol_deviations",
    "deviation_severity", "required_monitoring_complete", "session_documentation_complete",
}
assert required_columns <= columns, f"Colonne operative mancanti: {required_columns - columns}"
assert not columns.intersection({"allowed_visit_window", "out_of_window"}), "Finestre pronte trovate nel CSV"

all_kb = "\n".join((KB / p).read_text(encoding="utf-8") for p in EXPECTED).lower()
for forbidden in ["doi.org", "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "https://", "http://"]:
    assert forbidden not in all_kb, f"Fonte reale trovata nella KB: {forbidden}"

rules = (KB / "operations/deviation_escalation_rules.md").read_text(encoding="utf-8").lower()
for phrase in ["10 giorni", "30 giorni", "75%", "2 mesi", "major deviation"]:
    assert phrase in rules, f"Regola attesa non trovata: {phrase}"

print("Validazione KB superata.")
print(f"Documenti indicizzati previsti: {len(EXPECTED)}")
print("Week 6: PSI ±4 | ESK ±2 | DXB ±4 | SER ±5")
print("Fonti scientifiche reali escluse dalla KB.")
print("Schedule e synopsis coerenti con study_design.yaml; colonne operative presenti.")
print("Limite: questo controllo strutturale non approva nuove regole o decisioni aperte.")
