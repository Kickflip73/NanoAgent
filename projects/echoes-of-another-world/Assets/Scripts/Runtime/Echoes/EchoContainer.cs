using System;
using EchoesOfAnotherWorld.Runtime.Events;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Echoes
{
    public sealed class EchoContainer : MonoBehaviour
    {
        public const int MaximumSlots = 4;

        private readonly EchoMark[] equipped = new EchoMark[MaximumSlots];
        private readonly float[] cooldownEnds = new float[MaximumSlots];
        private StringEventChannel statusChanged;

        public int SelectedSlot { get; private set; }

        public event Action EquipmentChanged = delegate { };

        public void Configure(StringEventChannel statusChannel)
        {
            statusChanged = statusChannel;
        }

        public EchoMark GetEquipped(int slot)
        {
            return slot >= 0 && slot < MaximumSlots ? equipped[slot] : null;
        }

        public void Equip(int slot, EchoMark mark)
        {
            if (slot < 0 || slot >= MaximumSlots)
            {
                throw new ArgumentOutOfRangeException(nameof(slot));
            }

            equipped[slot] = mark;
            cooldownEnds[slot] = 0f;
            EquipmentChanged.Invoke();
        }

        public void SelectSlot(int slot)
        {
            SelectedSlot = Mathf.Clamp(slot, 0, MaximumSlots - 1);
            EquipmentChanged.Invoke();
        }

        public void SelectNext()
        {
            SelectedSlot = (SelectedSlot + 1) % MaximumSlots;
            EchoMark mark = equipped[SelectedSlot];
            statusChanged?.Raise(mark == null ? "空残响槽" : $"已选择：{mark.DisplayName}");
            EquipmentChanged.Invoke();
        }

        public bool UseSelected(Vector2 direction)
        {
            EchoMark mark = equipped[SelectedSlot];
            if (mark == null)
            {
                statusChanged?.Raise("当前残响槽为空");
                return false;
            }

            if (Time.time < cooldownEnds[SelectedSlot])
            {
                float remaining = cooldownEnds[SelectedSlot] - Time.time;
                statusChanged?.Raise($"{mark.DisplayName} 冷却中 {remaining:0.0}s");
                return false;
            }

            bool activated = mark.Activate(new EchoContext(this, transform, direction));
            if (activated)
            {
                cooldownEnds[SelectedSlot] = Time.time + mark.Cooldown;
                statusChanged?.Raise($"发动残响：{mark.DisplayName}");
            }

            return activated;
        }

        public string[] GetEquippedIds()
        {
            string[] ids = new string[MaximumSlots];
            for (int index = 0; index < MaximumSlots; index++)
            {
                ids[index] = equipped[index] == null ? string.Empty : equipped[index].Id;
            }

            return ids;
        }
    }
}
