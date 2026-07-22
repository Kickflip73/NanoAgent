using EchoesOfAnotherWorld.Runtime.Events;
using EchoesOfAnotherWorld.Runtime.Input;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Dialogue
{
    public sealed class DialogueSystem : MonoBehaviour
    {
        private PlayerInput playerInput;
        private Transform player;
        private StringEventChannel dialogueChanged;
        private DialogueNpc activeNpc;
        private int nodeIndex;

        public void Configure(
            PlayerInput input,
            Transform playerTransform,
            StringEventChannel changedChannel)
        {
            playerInput = input;
            player = playerTransform;
            dialogueChanged = changedChannel;
            playerInput.InteractPressed += OnInteract;
        }

        private void OnDestroy()
        {
            if (playerInput != null)
            {
                playerInput.InteractPressed -= OnInteract;
            }
        }

        private void OnInteract()
        {
            if (activeNpc != null)
            {
                ShowNextNode();
                return;
            }

            DialogueNpc nearest = FindNearestNpc();
            if (nearest == null)
            {
                dialogueChanged?.Raise("附近没有可交谈的人");
                return;
            }

            activeNpc = nearest;
            nodeIndex = 0;
            ShowNextNode();
        }

        private DialogueNpc FindNearestNpc()
        {
            DialogueNpc nearest = null;
            float nearestDistance = 2.25f;
            foreach (DialogueNpc npc in FindObjectsOfType<DialogueNpc>())
            {
                float distance = Vector2.Distance(player.position, npc.transform.position);
                if (distance < nearestDistance)
                {
                    nearest = npc;
                    nearestDistance = distance;
                }
            }

            return nearest;
        }

        private void ShowNextNode()
        {
            DialogueNode node = activeNpc.Dialogue?.GetNode(nodeIndex);
            if (node == null)
            {
                activeNpc = null;
                dialogueChanged?.Raise(string.Empty);
                return;
            }

            string merchantHint = activeNpc.IsMerchant ? "\n[商人：P1 演示商店]" : string.Empty;
            dialogueChanged?.Raise($"{node.Speaker}：{node.Text}{merchantHint}\n[F] 继续");
            nodeIndex++;
        }
    }
}
