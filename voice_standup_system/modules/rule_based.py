def rule_based(sentence):
    s = sentence.lower()

    if "block" in s or "issue" in s or "error" in s or "problem" in s:
        return "Blocker"

    elif "will" in s or "plan" in s or "going to" in s:
        return "Plan"

    elif "completed" in s or "fixed" in s or "done" in s or "finished" in s:
        return "Task"

    return "Task"