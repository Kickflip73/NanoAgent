using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Dialogue
{
    public sealed class DialogueNpc : MonoBehaviour
    {
        [SerializeField]
        private DialogueTree dialogue;

        [SerializeField]
        private bool merchant;

        public DialogueTree Dialogue => dialogue;

        public bool IsMerchant => merchant;

        public void Configure(DialogueTree dialogueTree, bool isMerchant)
        {
            dialogue = dialogueTree;
            merchant = isMerchant;
        }
    }
}
