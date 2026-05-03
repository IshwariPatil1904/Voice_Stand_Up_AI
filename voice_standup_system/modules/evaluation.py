from sklearn.metrics import accuracy_score, classification_report
from modules.dl_model import predict
from modules.rule_based import rule_based

# -------- TEST DATA --------
test_sentences = [
    # TASK (different wording)
    "Yesterday I handled login functionality",
    "I managed backend integration",
    "Completed work on API endpoints",

    # PLAN (not obvious words)
    "Going to start UI improvements",
    "Next I focus on testing module",
    "Planning database optimization",

    # BLOCKER (indirect language)
    "System is not responding properly",
    "There is some issue with server",
    "Facing unexpected bugs in code"
]

true_labels = [
    "Task", "Task", "Task",
    "Plan", "Plan", "Plan",
    "Blocker", "Blocker", "Blocker"
]

# -------- DL MODEL --------
dl_predictions = []
for s in test_sentences:
    pred = predict(s)
    dl_predictions.append(pred)

print("\n===== DEEP LEARNING MODEL =====")
print("Accuracy:", accuracy_score(true_labels, dl_predictions))
print(classification_report(true_labels, dl_predictions))


# -------- RULE-BASED MODEL --------
rb_predictions = []
for s in test_sentences:
    pred = rule_based(s)
    rb_predictions.append(pred)

print("\n===== RULE-BASED MODEL =====")
print("Accuracy:", accuracy_score(true_labels, rb_predictions))
print(classification_report(true_labels, rb_predictions))
import matplotlib.pyplot as plt

models = ["Deep Learning", "Rule-Based"]
accuracies = [
    accuracy_score(true_labels, dl_predictions),
    accuracy_score(true_labels, rb_predictions)
]

plt.figure()
plt.bar(models, accuracies)
plt.title("Model Accuracy Comparison")
plt.xlabel("Models")
plt.ylabel("Accuracy")

plt.savefig("accuracy_graph.png")
plt.show()