from modules.dl_model import predict

def generate_report(text):

    sentences = text.split('.')

    result = {
        "Task": [],
        "Plan": [],
        "Blocker": []
    }

    for s in sentences:
        s = s.strip()

        if s:
            category = predict(s)
            result[category].append(s)

    return result