using System;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Events
{
    public abstract class GameEventChannel<T> : ScriptableObject
    {
        public event Action<T> Raised = delegate { };

        public void Raise(T value)
        {
            Raised.Invoke(value);
        }
    }

    [CreateAssetMenu(menuName = "异界残响/事件/浮点事件")]
    public sealed class FloatEventChannel : GameEventChannel<float>
    {
    }

    [CreateAssetMenu(menuName = "异界残响/事件/整数事件")]
    public sealed class IntEventChannel : GameEventChannel<int>
    {
    }

    [CreateAssetMenu(menuName = "异界残响/事件/文本事件")]
    public sealed class StringEventChannel : GameEventChannel<string>
    {
    }
}
