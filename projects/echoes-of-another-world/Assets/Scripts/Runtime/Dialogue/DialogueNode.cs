using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Dialogue
{
    [CreateAssetMenu(menuName = "异界残响/对话/节点")]
    public sealed class DialogueNode : ScriptableObject
    {
        [SerializeField]
        private string speaker = string.Empty;

        [SerializeField, TextArea]
        private string text = string.Empty;

        public string Speaker => speaker;

        public string Text => text;

        public void Configure(string speakerName, string dialogueText)
        {
            speaker = speakerName;
            text = dialogueText;
        }
    }
}
