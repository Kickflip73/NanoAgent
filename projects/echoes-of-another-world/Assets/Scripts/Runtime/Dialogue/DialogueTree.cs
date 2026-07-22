using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Dialogue
{
    [CreateAssetMenu(menuName = "异界残响/对话/对话树")]
    public sealed class DialogueTree : ScriptableObject
    {
        [SerializeField]
        private DialogueNode[] nodes = System.Array.Empty<DialogueNode>();

        public int Count => nodes.Length;

        public DialogueNode GetNode(int index)
        {
            return index >= 0 && index < nodes.Length ? nodes[index] : null;
        }

        public void Configure(params DialogueNode[] dialogueNodes)
        {
            nodes = dialogueNodes ?? System.Array.Empty<DialogueNode>();
        }
    }
}
