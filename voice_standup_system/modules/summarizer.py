ANALYSIS_KEYS = ("Task", "Plan", "Blocker")


def empty_analysis():
    return {key: [] for key in ANALYSIS_KEYS}


def normalize_analysis(analysis):
    normalized = empty_analysis()

    if not isinstance(analysis, dict):
        return normalized

    for key in ANALYSIS_KEYS:
        value = analysis.get(key, [])

        if isinstance(value, list):
            normalized[key] = [item for item in value if item]
        elif value:
            normalized[key] = [str(value)]

    return normalized


def summarize_analyses(analyses):
    summary = empty_analysis()

    for analysis in analyses:
        normalized = normalize_analysis(analysis)
        for key in ANALYSIS_KEYS:
            summary[key].extend(normalized[key])

    return summary


def build_summary_text(analysis):
    normalized = normalize_analysis(analysis)
    parts = []

    if normalized["Task"]:
        parts.append(f"{len(normalized['Task'])} task update(s)")
    if normalized["Plan"]:
        parts.append(f"{len(normalized['Plan'])} planned next step(s)")
    if normalized["Blocker"]:
        parts.append(f"{len(normalized['Blocker'])} blocker(s)")

    if not parts:
        return "No clear standup items were detected."

    summary = "Meeting summary: " + ", ".join(parts) + "."

    if normalized["Blocker"]:
        summary += f" Key blocker: {normalized['Blocker'][0]}."
    elif normalized["Plan"]:
        summary += f" Next focus: {normalized['Plan'][0]}."
    elif normalized["Task"]:
        summary += f" Latest progress: {normalized['Task'][0]}."

    return summary
